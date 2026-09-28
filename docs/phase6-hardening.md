# Phase 6 — hardening and personal release

## Status

Implemented and accepted on `fork/phase6-hardening`. Kang accepted the installed release build. During acceptance he noted that the web widget cannot load arbitrary pages; this is the inherited iframe design, not a Phase 6 regression, and is tracked separately.

Automated evidence: Stage 0 10, Phase 1 3, Phase 2 17, Phase 3 3, Phase 4 9, Phase 5 9, Phase 6 8, installer 10, Rust 15, build, fmt/clippy `-D warnings`, the actual Pi companion probe, and a live paired-backend probe.

## Security fixes

### Optional web backend requires pairing

`server/pty-server.mjs` can open shells, run programs, and read or write files. Before this phase it answered every origin with `Access-Control-Allow-Origin: *`, had no Host check, and accepted WebSocket shells from any page. `/run` also accepted CORS-simple POSTs, so any website could execute a program while the backend was running.

The backend now generates fresh 256-bit capabilities on each start:

- **master token** — commands, files, directory listing, media, and the PTY WebSocket;
- **proxy token** — only `/proxy`, because a proxied page can read its own URL.

Requests must use a loopback Host on the configured port, which blocks DNS rebinding. A present Origin must be a fork UI origin. CORS is reflected only to those origins, never `*`. WebSockets require both an allowed Origin and the master token. Proxied pages and served media use `Content-Security-Policy: sandbox`, which gives them an opaque origin.

Only `/health` without a token is public, and it returns liveness only.

Pairing:

- **Web UI:** open the `pair web` URL printed by `npm run server`. The token moves from the URL fragment to `sessionStorage` and the fragment is removed.
- **Desktop app:** the optional proxy reads `~/.config/ccanvas-pi/backend-token.json`. The file is written mode `0600`, rotated on every start, and removed on clean shutdown. A custom `XDG_CONFIG_HOME` is used by the server but not discovered by the desktop app.

### Desktop media server capability

The embedded Rust media server listened on a random loopback port, accepted arbitrary `path` values, and sent `Access-Control-Allow-Origin: *`. A local port scan from any web page could read files. Every route is now under `/m/<per-launch capability>/`, returned to the app only through `media_info`. Without strong randomness, which is not yet available on Windows, the server does not start and media uses the asset protocol.

### Document-controlled Claude launch fields

Claude agents launch by typing a command into a shell. Saved `sessionId` and `model` values were interpolated without validation, so a crafted `.ccnvs` file could inject shell commands. Session IDs must now be UUIDs, models must match a fixed identifier grammar, and titles are stripped of shell-significant and control characters.

### PTY-bound prompt text

Initial prompts, roster/broadcast text, and flow output delivered to PTY agents are data, not terminal control. C0/C1 controls, escapes, and carriage returns are removed before bracketed paste, so text cannot close the paste block, submit early, or emit terminal escape sequences. Pi semantic controls already bypass the PTY.

### Opened documents require activation

A `.ccnvs` file can name executables, cwd, prompts, and Claude's permission bypass. Opening one is no longer consent to launch it. Canvases opened from files that contain agents render activation gates instead of starting agents. A top bar summarizes Pi/Claude counts and permission-bypass requests; one explicit action activates the canvas. The flag is local state saved in autosave but never written into `.ccnvs` files.

### One writer per Pi session

Opening the same canvas twice could resume one Pi session file from two processes. The native runtime now leases the canonical session file under its runtime lock. A second live launch is refused until the first agent is closed.

## Residual limits

- Tauri keeps `csp: null` and asset-protocol scope `**`; web previews, local HTML, media, and Monaco depend on them. Narrowing them needs a separate compatibility pass.
- Session leases cover managed runtimes in one app process and the file each agent launched with. They do not detect Pi TUIs outside ccanvas, a second app instance, or sessions switched inside the TUI.
- Template naming, checkpoint labels, and Git-panel repo/branch prompts use `window.prompt`/`confirm`, which the macOS webview ignores.
- The web widget is an `<iframe>`. In the desktop app, sites that forbid framing via `X-Frame-Options`/`frame-ancestors`, and plain `http://` non-localhost pages blocked as mixed content, do not render. The only workaround is the optional paired Node proxy, which is partial: logins, cookies, and cross-origin APIs often fail.
- Managed Pi agents require the desktop app. The web backend does not host the Pi companion runtime.
- Windows lacks capability generation and Job Object process ownership, so managed Pi fails visibly.

## Support matrix

| Surface | Status |
| --- | --- |
| macOS desktop app, managed Pi agents | Supported and exercised |
| macOS desktop app, legacy Claude agents | Supported compatibility path |
| Web mode terminals/files via paired backend | Hardened; exercised by tests, not a daily path |
| Web mode managed Pi agents | Not supported |
| Linux/Windows | Builds in CI; runtime parity not claimed |

## Install and recovery

Prerequisites: Pi installed by you and reachable as the configured `pi` launcher, with its own credentials and trust. ccanvas never installs Pi, reads its credentials, or changes project trust.

- `npm run app:build` installs a release build to `~/Applications/ccanvas Pi.app`. Quit the app first.
- To roll back, reinstall a previous build or check out an earlier merge and run the installer again.
- Pi sessions remain ordinary Pi sessions and can be resumed natively.
- `.ccnvs` v2 files are not automatically downgraded; keep copies before trying older builds.

## What is not done

- No web-mode managed Pi runtime.
- No Windows capability generation or process ownership.
- No CSP/asset-scope narrowing.
- No cross-instance session locking.
