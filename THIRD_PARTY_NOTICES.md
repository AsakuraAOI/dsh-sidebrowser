# Third-party sources

## guanhaisen/dsh-agent-browser

- Repository: https://github.com/guanhaisen/dsh-agent-browser
- Reference commit: `063465a77aa7c7ca1a154bd487ccd165e3f90185`
- Copyright (c) 2026 六花学编程 (guanhaisen)
- License: MIT; the original notice is retained in `LICENSE`.
- `index.js` and `src/client-template.js` are derived from the reference Host/Client implementation. They retain its sidebar integration, viewport controls, screenshot handling, and basic DOM operations. Local changes add the transport envelope, stricter ownership and reference handling, async evaluation, new tools, native input and observation workflow.

## eze-is/web-access

- Repository: https://github.com/eze-is/web-access
- Studied commit: `d173a75978ceb2c63fa0b27f7408cd2bf7fe4310` (v2.6.0 metadata).
- Upstream declares MIT.
- Used as design guidance for observe/act/verify, content readiness, explicit fallback and native-input distinctions. Its CDP Proxy, browser discovery, history reader and background service are not bundled or started. This plugin uses Electron webview input APIs instead of deploying that proxy.

## Test dependency

`happy-dom` is used only by development tests. Its package and license remain in the development dependency tree; it is not included in the installable plugin tarball.
