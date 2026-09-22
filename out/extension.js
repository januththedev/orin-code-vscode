"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const API = 'https://orinai.org';
const TOKEN_KEY = 'orin.sessionToken';
async function authedFetch(path, token, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    try {
        const r = await fetch(API + path, {
            method: 'POST',
            signal: ctrl.signal,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok)
            throw new Error(j.error || `HTTP ${r.status}`);
        return j;
    }
    finally {
        clearTimeout(timer);
    }
}
async function publicPost(path, body) {
    const r = await fetch(API + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok)
        throw new Error(j.error || `HTTP ${r.status}`);
    return j;
}
/** Device-flow sign-in: browser approves, token lands in secret storage. */
async function signIn(ctx) {
    const start = await publicPost('/api/auth/device', { action: 'start' });
    const choice = await vscode.window.showInformationMessage(`Orin Code: enter ${start.user_code} in the browser to sign in.`, 'Open browser', 'Cancel');
    if (choice !== 'Open browser')
        return null;
    await vscode.env.openExternal(vscode.Uri.parse(start.verify_url));
    const deadline = Date.now() + (start.expires_in || 600) * 1000;
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Waiting for browser approval…', cancellable: true }, async (_p, cancel) => {
        while (Date.now() < deadline) {
            if (cancel.isCancellationRequested)
                return null;
            await new Promise((r) => setTimeout(r, (start.interval || 3) * 1000));
            try {
                const t = await publicPost('/api/auth/device', {
                    action: 'token',
                    device_code: start.device_code,
                });
                if (t.status === 'approved' && (t.session_token || t.custom_token)) {
                    const token = t.session_token || t.custom_token;
                    await ctx.secrets.store(TOKEN_KEY, token);
                    vscode.window.showInformationMessage('Orin Code: signed in.');
                    return token;
                }
                if (t.status === 'denied' || t.status === 'expired')
                    return null;
            }
            catch { /* keep polling */ }
        }
        return null;
    });
}
async function ensureToken(ctx) {
    const saved = await ctx.secrets.get(TOKEN_KEY);
    if (saved)
        return saved;
    return signIn(ctx);
}
async function askChat(token, prompt, thinking) {
    const j = await authedFetch('/api/chat', token, { prompt, thinking });
    let text = j.text || '(empty)';
    if (j.links?.length) {
        text += '\n\nSources:\n' + j.links.map((l) => `- ${l.title || l.uri}: ${l.uri}`).join('\n');
    }
    return text;
}
class OrinChatProvider {
    constructor(ctx) {
        this.ctx = ctx;
        this.history = [];
    }
    resolveWebviewView(view) {
        this.view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = this.html();
        view.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'send')
                await this.send(msg.text, msg.thinking);
            if (msg.type === 'clear') {
                this.history = [];
                this.post({ type: 'reset' });
            }
        });
    }
    post(msg) {
        this.view?.webview.postMessage(msg);
    }
    newChat() {
        this.history = [];
        this.post({ type: 'reset' });
    }
    async sendWithContext(extra) {
        const editor = vscode.window.activeTextEditor;
        const sel = editor?.document.getText(editor.selection) || '';
        if (!sel.trim()) {
            vscode.window.showInformationMessage('Select some code first.');
            return;
        }
        await this.send(`${extra}\n\n\`\`\`\n${sel}\n\`\`\``, false);
        await vscode.commands.executeCommand('orinChat.focus');
    }
    async send(text, thinking) {
        const prompt = String(text || '').trim();
        if (!prompt)
            return;
        this.post({ type: 'user', text: prompt });
        this.history.push({ role: 'user', content: prompt });
        this.post({ type: 'typing' });
        try {
            const token = await ensureToken(this.ctx);
            if (!token) {
                this.post({ type: 'error', text: 'Sign-in cancelled.' });
                return;
            }
            const reply = await askChat(token, prompt, thinking);
            this.history.push({ role: 'assistant', content: reply });
            this.post({ type: 'bot', text: reply });
        }
        catch (e) {
            if (/401|Unauthorized|Invalid/i.test(e?.message || '')) {
                await this.ctx.secrets.delete(TOKEN_KEY);
                this.post({ type: 'error', text: 'Session expired — send again to sign in fresh.' });
            }
            else {
                this.post({ type: 'error', text: e?.message || 'Chat failed.' });
            }
        }
    }
    html() {
        return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); margin: 0; display: flex; flex-direction: column; height: 100vh; }
#log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.msg { padding: 9px 12px; border-radius: 10px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.user { background: var(--vscode-button-background); color: var(--vscode-button-foreground); align-self: flex-end; max-width: 92%; }
.bot { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); align-self: flex-start; max-width: 96%; }
.err { color: var(--vscode-errorForeground); font-size: 12px; }
#bar { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--vscode-panel-border); }
#in { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 8px; padding: 8px 10px; font-family: inherit; font-size: 13px; resize: none; }
#send { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 8px; padding: 0 16px; cursor: pointer; font-weight: 700; }
.row { display: flex; align-items: center; gap: 8px; padding: 0 10px 10px; font-size: 12px; color: var(--vscode-descriptionForeground); }
.typing { opacity: .6; font-style: italic; }
</style></head><body>
<div id="log"></div>
<div class="row"><label><input type="checkbox" id="deep"> Deep reasoning</label></div>
<div id="bar"><textarea id="in" rows="2" placeholder="Ask Orin about your code…"></textarea><button id="send">➤</button></div>
<script>
const vscode = acquireVsCodeApi();
const log = document.getElementById('log'), input = document.getElementById('in'), deep = document.getElementById('deep');
function add(cls, text) { const d = document.createElement('div'); d.className = 'msg ' + cls; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; }
function send() { const t = input.value.trim(); if (!t) return; input.value = ''; vscode.postMessage({ type: 'send', text: t, thinking: deep.checked }); }
document.getElementById('send').addEventListener('click', send);
input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
window.addEventListener('message', e => {
  const m = e.data;
  if (m.type === 'user') add('user', m.text);
  else if (m.type === 'bot') { document.querySelectorAll('.typing').forEach(x => x.remove()); add('bot', m.text); }
  else if (m.type === 'error') { document.querySelectorAll('.typing').forEach(x => x.remove()); add('err', m.text); }
  else if (m.type === 'typing') add('typing', 'Orin is thinking…');
  else if (m.type === 'reset') log.innerHTML = '';
});
</script></body></html>`;
    }
}
function activate(ctx) {
    const provider = new OrinChatProvider(ctx);
    ctx.subscriptions.push(vscode.window.registerWebviewViewProvider('orinChat', provider), vscode.commands.registerCommand('orin.signIn', async () => { await signIn(ctx); }), vscode.commands.registerCommand('orin.signOut', async () => {
        await ctx.secrets.delete(TOKEN_KEY);
        vscode.window.showInformationMessage('Orin Code: signed out.');
    }), vscode.commands.registerCommand('orin.explainSelection', () => provider.sendWithContext('Explain this code briefly:')), vscode.commands.registerCommand('orin.newChat', () => provider.newChat()));
}
function deactivate() { }
//# sourceMappingURL=extension.js.map