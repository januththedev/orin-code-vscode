import * as vscode from 'vscode';
import { createHash, randomBytes } from 'node:crypto';

const DEFAULT_API = 'https://orinai.org';
const CLIENT_ID = 'orin-code-vscode';
const SCOPES = ['chat:use', 'account:read', 'tools:use', 'code:use'];
const CREDENTIAL_KEY = 'orin.credential.v2';

type Credential = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  uid: string;
  email: string;
  authKind: 'device' | 'environment';
};

type ApiResponse = Record<string, any>;

class OrinApiError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
    this.name = 'OrinApiError';
  }
}

function apiOrigin(): string {
  const configured = process.env.ORIN_API || vscode.workspace.getConfiguration('orin').get<string>('apiBase') || DEFAULT_API;
  let url: URL;
  try { url = new URL(configured); } catch { throw new OrinApiError('Orin API base is invalid.'); }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new OrinApiError('Orin API base must use HTTPS (or explicit localhost).');
  if (url.username || url.password || url.search || url.hash) throw new OrinApiError('Orin API base cannot contain credentials, query, or fragment.');
  return url.origin;
}

function validVerificationUrl(value: unknown, origin: string): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    return (url.protocol === 'https:' || (url.protocol === 'http:' && local)) && url.origin === origin && !url.username && !url.password;
  } catch { return false; }
}

function validDeviceCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{40,128}$/.test(value);
}

function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function publicPost(path: string, body: unknown, timeoutMs = 30_000): Promise<ApiResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(apiOrigin() + path, {
      method: 'POST',
      signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({})) as ApiResponse;
    if (!response.ok) throw new OrinApiError(data?.error?.message || data?.error || `HTTP ${response.status}`, response.status);
    return data;
  } catch (error) {
    if (error instanceof OrinApiError) throw error;
    if ((error as Error)?.name === 'AbortError') throw new OrinApiError('Orin request timed out.');
    throw new OrinApiError(error instanceof Error ? error.message : 'Network request failed.');
  } finally { clearTimeout(timer); }
}

async function readCredential(ctx: vscode.ExtensionContext): Promise<Credential | null> {
  const raw = await ctx.secrets.get(CREDENTIAL_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Credential>;
    if (typeof value.accessToken !== 'string' || !value.accessToken.trim()) return null;
    return {
      accessToken: value.accessToken.trim(),
      refreshToken: typeof value.refreshToken === 'string' ? value.refreshToken : null,
      expiresAt: Number(value.expiresAt) || 0,
      uid: typeof value.uid === 'string' ? value.uid : '',
      email: typeof value.email === 'string' ? value.email : '',
      authKind: value.authKind === 'environment' ? 'environment' : 'device',
    };
  } catch { return null; }
}

async function writeCredential(ctx: vscode.ExtensionContext, credential: Credential): Promise<void> {
  await ctx.secrets.store(CREDENTIAL_KEY, JSON.stringify(credential));
}

async function clearCredential(ctx: vscode.ExtensionContext): Promise<void> {
  await ctx.secrets.delete(CREDENTIAL_KEY);
}

async function refreshCredential(ctx: vscode.ExtensionContext, credential: Credential): Promise<Credential> {
  if (!credential.refreshToken) throw new OrinApiError('Your Orin session expired. Run Orin: Sign in.');
  const data = await publicPost('/api/auth/device', { action: 'refresh', refresh_token: credential.refreshToken });
  if (typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string') throw new OrinApiError('Core returned an invalid refresh response.');
  const next: Credential = {
    ...credential,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 900) * 1000,
    authKind: 'device',
  };
  await writeCredential(ctx, next);
  return next;
}

async function ensureAccess(ctx: vscode.ExtensionContext): Promise<string> {
  const credential = await readCredential(ctx);
  if (!credential) throw new OrinApiError('Not signed in. Run Orin: Sign in.');
  if (credential.expiresAt > Date.now() + 120_000) return credential.accessToken;
  return (await refreshCredential(ctx, credential)).accessToken;
}

async function authedPost(ctx: vscode.ExtensionContext, path: string, body: unknown, retry = true): Promise<ApiResponse> {
  const token = await ensureAccess(ctx);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(apiOrigin() + path, {
      method: 'POST',
      signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({})) as ApiResponse;
    if (response.status === 401 && retry) {
      await clearCredential(ctx);
      return authedPost(ctx, path, body, false);
    }
    if (!response.ok) throw new OrinApiError(data?.error?.message || data?.error || `HTTP ${response.status}`, response.status);
    return data;
  } catch (error) {
    if (error instanceof OrinApiError) throw error;
    if ((error as Error)?.name === 'AbortError') throw new OrinApiError('Orin request timed out.');
    throw new OrinApiError(error instanceof Error ? error.message : 'Network request failed.');
  } finally { clearTimeout(timer); }
}

async function signIn(ctx: vscode.ExtensionContext): Promise<boolean> {
  const { verifier, challenge } = createPkce();
  const start = await publicPost('/api/auth/device', {
    action: 'start', client_id: CLIENT_ID, code_challenge: challenge,
    code_challenge_method: 'S256', scopes: SCOPES,
  });
  if (!validDeviceCode(start.device_code) || !validVerificationUrl(start.verification_uri, apiOrigin())) throw new OrinApiError('Core returned an invalid device authorization response.');
  const choice = await vscode.window.showInformationMessage(`Orin Code: enter ${start.user_code} in the browser to sign in.`, 'Open browser', 'Cancel');
  if (choice !== 'Open browser') return false;
  await vscode.env.openExternal(vscode.Uri.parse(start.verification_uri));
  const deadline = Date.now() + (Number(start.expires_in) || 480) * 1000;
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Waiting for browser approval…', cancellable: true },
    async (_progress, cancel) => {
      while (Date.now() < deadline) {
        if (cancel.isCancellationRequested) return false;
        await new Promise((resolve) => setTimeout(resolve, Math.max(3, Number(start.interval) || 5) * 1000));
        try {
          const token = await publicPost('/api/auth/device', {
            action: 'token', client_id: CLIENT_ID, device_code: start.device_code, code_verifier: verifier,
          });
          if (token.status === 'approved' && typeof token.access_token === 'string' && typeof token.refresh_token === 'string') {
            const profile = await authedPost(ctx, '/api/auth/session/introspect', {}, false).catch(async () => {
              const response = await fetch(apiOrigin() + '/api/auth/session/introspect', {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.access_token}` }, body: '{}',
              });
              const data = await response.json().catch(() => ({})) as ApiResponse;
              if (!response.ok) throw new OrinApiError(data?.error?.message || 'Could not read the Orin profile.', response.status);
              return data;
            });
            await writeCredential(ctx, {
              accessToken: token.access_token, refreshToken: token.refresh_token,
              expiresAt: Date.now() + (Number(token.expires_in) || 900) * 1000,
              uid: String(profile.uid || ''), email: String(profile.email || ''), authKind: 'device',
            });
            vscode.window.showInformationMessage('Orin Code: signed in.');
            return true;
          }
          if (token.status === 'denied' || token.status === 'expired') return false;
        } catch (error) {
          if (error instanceof OrinApiError && error.status >= 400 && error.status < 500) throw error;
        }
      }
      return false;
    },
  );
}

function safeLink(value: unknown): value is { title?: string; url?: string; uri?: string } {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const raw = typeof item.url === 'string' ? item.url : typeof item.uri === 'string' ? item.uri : '';
  try { const url = new URL(raw); return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password; } catch { return false; }
}

async function askChat(ctx: vscode.ExtensionContext, prompt: string, thinking: boolean, history: Array<{ role: string; content: string }>): Promise<string> {
  const data = await authedPost(ctx, '/api/chat', {
    mode: 'chat', model: thinking ? 'orin-thinking' : 'orin-balanced', prompt, history: history.slice(-10),
  });
  let text = typeof data.text === 'string' && data.text.trim() ? data.text : '(empty)';
  const links = Array.isArray(data.links) ? data.links.filter(safeLink) : Array.isArray(data.citations) ? data.citations.filter(safeLink) : [];
  if (links.length) text += '\n\nSources:\n' + links.map((link: any) => `- ${String(link.title || link.url || link.uri).slice(0, 200)}: ${link.url || link.uri}`).join('\n');
  return text;
}

class OrinChatProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private history: Array<{ role: string; content: string }> = [];

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const item = message as Record<string, unknown>;
      if (item.type === 'send') void this.send(typeof item.text === 'string' ? item.text.slice(0, 100_000) : '', item.thinking === true);
      if (item.type === 'clear') this.newChat();
    });
  }

  post(message: unknown): void { void this.view?.webview.postMessage(message); }

  newChat(): void { this.history = []; this.post({ type: 'reset' }); }

  async sendWithContext(prefix: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const selection = editor?.document.getText(editor.selection) || '';
    if (!selection.trim()) { void vscode.window.showInformationMessage('Select some code first.'); return; }
    await this.send(`${prefix}\n\n\`\`\`\n${selection.slice(0, 100_000)}\n\`\`\``, false);
    await vscode.commands.executeCommand('orinChat.focus');
  }

  private async send(rawText: string, thinking: boolean): Promise<void> {
    const text = rawText.trim();
    if (!text) return;
    this.post({ type: 'user', text });
    this.history.push({ role: 'user', content: text });
    this.post({ type: 'typing' });
    try {
      const reply = await askChat(this.ctx, text, thinking, this.history.slice(0, -1));
      this.history.push({ role: 'assistant', content: reply });
      this.post({ type: 'bot', text: reply });
    } catch (error) {
      if (error instanceof OrinApiError && error.status === 401) {
        await clearCredential(this.ctx);
        this.post({ type: 'error', text: 'Session expired — run Orin: Sign in.' });
      } else this.post({ type: 'error', text: error instanceof Error ? error.message : 'Chat failed.' });
    }
  }

  private html(): string {
    const nonce = randomBytes(16).toString('base64url');
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">
body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); margin: 0; display: flex; flex-direction: column; height: 100vh; }
#log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.msg { padding: 9px 12px; border-radius: 10px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.user { background: var(--vscode-button-background); color: var(--vscode-button-foreground); align-self: flex-end; max-width: 92%; }
.bot { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); align-self: flex-start; max-width: 96%; }
.err { color: var(--vscode-errorForeground); font-size: 12px; }
#bar { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--vscode-panel-border); }
#in { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 8px; padding: 8px 10px; font-family: inherit; font-size: 13px; resize: none; }
#send { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 8px; padding: 0 16px; cursor: pointer; font-weight: 700; }
.row { display: flex; gap: 8px; padding: 10px; font-size: 12px; color: var(--vscode-descriptionForeground); }
.typing { opacity: .6; font-style: italic; }
</style></head><body>
<div id="log"></div><div class="row"><label><input type="checkbox" id="deep"> Deep reasoning</label></div><div id="bar"><textarea id="in" rows="2" placeholder="Ask Orin about your code…"></textarea><button id="send">➤</button></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi(); const log = document.getElementById('log'), input = document.getElementById('in'), deep = document.getElementById('deep');
function add(cls, text) { const d = document.createElement('div'); d.className = 'msg ' + cls; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; }
function send() { const t = input.value.trim(); if (!t) return; input.value = ''; vscode.postMessage({ type: 'send', text: t, thinking: deep.checked }); }
document.getElementById('send').addEventListener('click', send); input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
window.addEventListener('message', e => { const m = e.data; if (m.type === 'user') add('user', m.text); else if (m.type === 'bot') { document.querySelectorAll('.typing').forEach(x => x.remove()); add('bot', m.text); } else if (m.type === 'error') { document.querySelectorAll('.typing').forEach(x => x.remove()); add('err', m.text); } else if (m.type === 'typing') add('typing', 'Orin is thinking…'); else if (m.type === 'reset') log.innerHTML = ''; });
</script></body></html>`;
  }
}

export function activate(ctx: vscode.ExtensionContext): void {
  const provider = new OrinChatProvider(ctx);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider('orinChat', provider),
    vscode.commands.registerCommand('orin.signIn', async () => { try { await signIn(ctx); } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Orin sign-in failed.'); } }),
    vscode.commands.registerCommand('orin.signOut', async () => { await clearCredential(ctx); void vscode.window.showInformationMessage('Orin Code: signed out.'); }),
    vscode.commands.registerCommand('orin.explainSelection', () => provider.sendWithContext('Explain this code briefly:')),
    vscode.commands.registerCommand('orin.newChat', () => provider.newChat()),
  );
}

export function deactivate(): void {}
