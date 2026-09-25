# Orin Code for VS Code

Orin Code chat in your editor, backed by the same Orin Core account as the
desktop app and CLI. No API keys are stored in the extension.

- Sidebar chat with a Deep reasoning toggle
- `Orin: Explain selection` on any code
- Core device PKCE sign-in
- Access and rotated refresh credentials in VS Code `SecretStorage`
- Conversation history is sent to Core with each turn and cleared by `Orin: New chat`
- Verification links are validated against the configured Core origin before
  opening through VS Code's external-URL API

Build:

```bash
npm install
npm run compile
npx vsce package
```

Install the generated `.vsix` through Extensions → Install from VSIX.

The optional `orin.apiBase` setting (or `ORIN_API` for local development) must
be HTTPS; plain HTTP is accepted only for explicit localhost. The extension
uses the Core `/api/auth/device` and `/api/chat` contracts. It does not store
bearer or refresh tokens in workspace state, settings JSON, or webview local
storage.
