# Contributing to ccanvas

Thanks for your interest in improving ccanvas! This document explains how to get
a development environment running and how to propose changes.

## Code of Conduct

This project ships with a [Code of Conduct](./CODE_OF_CONDUCT.md). By
participating you agree to uphold it. Please report unacceptable behavior to the
maintainers.

## Getting started

### Prerequisites

- **Node.js 20+** and npm (development was done on Node 24)
- **Rust toolchain** via [`rustup`](https://rustup.rs/) — required only for the
  Tauri desktop build
- On **Windows**: the WebView2 runtime (preinstalled on Windows 11)
- On **Linux**: the standard Tauri system dependencies (`libwebkit2gtk-4.1`,
  `libgtk-3`, `librsvg2`, etc. — see the
  [Tauri prerequisites](https://tauri.app/start/prerequisites/))

### Install

```bash
npm install
```

### Run

```bash
npm run app     # native desktop app (Tauri) — the recommended dev loop
npm run dev     # fork web app only → http://127.0.0.1:5174
npm start        # web app + PTY backend (two processes) for browser terminals
npm run server   # the optional fork PTY/file backend on 127.0.0.1:7532
```

### Build

```bash
npm run test:stage0 # fork isolation and schema-migration checks; no Pi/model calls
npm run test:phase1 # controller identity/generation checks; no Pi/model calls
npm run test:phase2 # companion protocol/extension unit tests; no Pi/model calls
npm run build      # type-check + bundle the web app into dist/
npm run test:app-install # installer/build-wrapper tests; no real Applications writes
npm run probe:terminal # optional POSIX/zsh line-editing regression; no model calls
npm run probe:pi:companion # optional actual-Pi synthetic companion probe; no model/tools
npm run app:install # macOS: unsigned debug build + install to ~/Applications
npm run app:build   # release build; macOS also installs after success
npm run app:build -- --debug # faster rebuild + install
npm run app:bundle # raw Tauri packaging, no automatic local installation
```

On macOS, quit **ccanvas Pi** before rebuilding. The local build commands use cached
Cargo dependencies (`--offline --locked`), install only the fork bundle, register
Launch Services and request Spotlight indexing. Failed builds never install an old
artifact. CI/non-macOS runs skip local installation. Use
`CCANVAS_SKIP_APP_INSTALL=1 npm run app:build -- --debug` to opt out, or
`npm run app:bundle -- ...` for custom targets/signing/other Tauri flags. Vite
builds and `npm run app` hot reload do not update the installed app.

## Project layout

| Path                     | What lives there                                                |
| ------------------------ | --------------------------------------------------------------- |
| `src/store/workspace.ts` | Single Zustand store; the active workspace serializes to `.ccnvs` |
| `src/canvas/`            | Pointer/zoom state machine, SVG vector layer, inline text       |
| `src/widgets/`           | `WidgetFrame` chrome + per-type widget bodies                   |
| `src/ui/`                | Toolbar, command palette, HUD, props, tabs, minimap             |
| `src/lib/`               | Backend abstraction, terminal transport, persistence, geometry  |
| `src-tauri/`             | The Rust desktop app (`pty.rs`, `files.rs`, `watch.rs`)         |
| `server/pty-server.mjs`  | Optional web-mode PTY + file backend                            |

See the **Architecture notes** in the [README](./README.md#architecture-notes)
for how the pieces fit together.

## Making changes

1. **Fork** the repo and create a topic branch from `main`:
   `git checkout -b feat/short-description`.
2. Keep changes focused — one logical change per pull request.
3. Match the surrounding code style. The TypeScript config is strict
   (`noUnusedLocals`, `noUnusedParameters`, `strict`); make sure
   `npm run build` passes before opening a PR.
4. If you touch Rust, run `cargo fmt` and `cargo clippy` inside `src-tauri/`.
5. Write a clear commit message describing the *why*, not just the *what*.

## Opening a pull request

- Fill in the pull request template.
- Reference any related issue (e.g. `Closes #12`).
- Describe how you tested the change (which platform, web vs desktop).
- CI must be green before a maintainer reviews.

## Reporting bugs and requesting features

Use the GitHub issue templates. For bugs, include your OS, whether you were on
the desktop or web build, and the steps to reproduce. For security issues, see
[SECURITY.md](./SECURITY.md) — please do **not** open a public issue.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](./LICENSE) that covers the project.
