# ccanvas Pi — phase 0 completion record

## TL;DR

The personal fork and isolation scaffolding are in place, and baseline/regression
checks pass. **The integration-mode decision is the important change:** the user's
all-extensions requirement cannot be met by vanilla RPC alone with the currently
installed stack. **Kang approved Pi TUI + a companion event/control bridge on
2026-09-24**, preserving dashboard-specific services. Native UI/synthetic-session
probes now pass, and an unsigned native app builds and installs. Kang completed
the live terminal/Pi, extension-dialog, manual-resume and side-by-side checks and
accepted phase 0 on 2026-09-24. The production bridge is not built.

## Short version

- Fork: https://github.com/chunkanglu/ccanvas (parent: DevoidSloth/ccanvas).
- Local branch: `fork/bootstrap`, based on upstream `6f91395` / v0.5.1.
- `origin` points to the personal fork; `upstream` retains the original repository;
  local `remote.pushDefault=origin` prevents an ordinary push targeting upstream.
- Phase 0 is prepared as one local fork commit; no branch push or release was produced.
- Native app identity, development/preview/backend ports, browser storage and
  checkpoint refs are isolated. Normal `.ccnvs` v1 semantics are unchanged.
- Normal-discovery RPC startup and native TUI probes pass. The latter exercises
  custom UI cancellation, intercom, and synthetic session resume/switch/clone.
- An unsigned local macOS debug bundle installs and launches with fork-specific
  WebKit/cache/log state. Kang accepted terminal behavior, Pi launch and
  upstream/fork side-by-side isolation in the packaged GUI.

## Isolation implementation

| Surface | Upstream | Personal fork |
| --- | --- | --- |
| App/window title | ccanvas | ccanvas Pi |
| Tauri identifier | dev.ccanvas.app | io.github.chunkanglu.ccanvas-pi |
| Vite development | 127.0.0.1:5173 | 127.0.0.1:5174, strict port |
| Vite preview | default 4173 | 127.0.0.1:4174, strict port |
| Node backend | 127.0.0.1:7531 | 127.0.0.1:7532 |
| Local storage | ccanvas:* | ccanvas-pi:* |
| Git checkpoints | refs/ccanvas/cp/* | refs/ccanvas-pi/cp/* |
| Release workflow | automatic v* publishing | manual pi-v* draft prereleases, fork-only |

`fork.config.json` centralizes frontend/server port settings, storage namespace,
checkpoint prefix, app identity and the proposed Pi launcher. Tauri and HTML
metadata are checked for agreement by `npm run test:stage0`. The launch profile is
used by the probe only: **current agent widgets still launch Claude** until the
later integration stages.

The fork intentionally does not discover/import upstream localStorage; restoring
it could auto-launch upstream agents. Explicit file import remains possible.
Use **copies** of existing canvas files while evaluating: selected workspace paths
are still real filesystem paths, and saving to the same path can overwrite a file.
The app identity isolates native app data, not arbitrary user-selected files or
Pi/Claude home directories.

Release automation now checks out the selected fork tag and creates only draft
prereleases. No release action was dispatched or tags created. At Kang's request,
the unsigned local app is now installed in `~/Applications/ccanvas Pi.app`; this
is not a published release. Existing package/Cargo versions remain at the upstream baseline until
release preparation; no package installation or lockfile update was required.

## Compatibility decision and evidence

See [pi-compatibility.md](pi-compatibility.md) for the source-backed ledger,
installed component versions, and remaining acceptance scenarios.

Confirmed launcher: `PI_TOOLS_IDLE_TIMEOUT_MS=6000000 pi`.
Native TUI is optional aesthetically; preserving extension behavior is mandatory.
Intercom's overlay explicitly requires `ctx.mode === 'tui'`, guardrails path-access
uses `ctx.ui.custom()`, MCP has mode-specific URL elicitation behavior, and the
dashboard extends UI through its own PromptBus. A generic RPC frontend does not
preserve all of those semantics.

Accepted scope refinement: keep the stage 1 schema/controller design, then
implement the primary Pi integration as an interactive process with a companion
structured bridge. RPC can remain an optional adapter. A TUI by itself is not a
claim that dashboard-only controls or other terminal-host integrations work.
See [native probe and transport constraints](pi-tui-probe.md) for the approved
mode, test boundaries, lifecycle rules and remaining PTY ownership work.

## Verification evidence — 2026-09-24

Environment: macOS, Node 22.23.2, npm 10.9.8, cargo/rustc 1.98.0, Pi 0.84.1.

| Check | Result | Limits |
| --- | --- | --- |
| Untouched upstream `npm run build` | PASS | Existing large-chunk warning |
| Untouched upstream `cargo fmt --all --check` | PASS | No formatter changes |
| Untouched upstream `cargo clippy --offline --locked --all-targets` | PASS | Local cached dependencies only |
| Fork `npm run test:stage0` | PASS, 8 tests | Isolation/fixture checks plus test-extension privacy, input refusal and teardown; not full app UI tests |
| Fork `npm run build` | PASS | Same large-chunk warning |
| Fork Rust fmt + offline locked clippy | PASS | Not a packaged GUI run |
| Actual Pi startup probe | PASS | `get_state` + `get_commands`, 3 extension UI events, 0 malformed stdout lines; no model/tool commands or persistence |
| Native Pi PTY probe | PASS, 7 checks; two consecutive successful runs | Custom UI + confirmation cancellation, real intercom overlay, synthetic session lifecycle; no model/tool calls |
| Unsigned macOS debug bundle | PASS, build/install/process smoke plus user acceptance | Info.plist identity agrees; fork WebKit/cache/log paths created; normal terminal behavior, Pi launch and side-by-side isolation manually accepted |
| Node backend health on 7532 | HTTP 200 | Health endpoint only; no PTY/session test |
| Built frontend preview on 4174 | HTTP 200, title ccanvas Pi | Not a rendered-browser visual inspection |
| Local install/rebuild scripts | PASS, 10 unit tests plus real `app:install` and `app:build -- --debug` | Full-bundle replacement into ~/Applications; running-app/identity guards, stale-build rejection; mocked release path, no real release-mode build in this check |
| Spotlight indexing | PASS | `mdls` reports fork name/identifier and `mdfind` returns installed path; no human Spotlight click tested |
| `git diff --check` | PASS | Whitespace only |

The backend, preview, native-app and Pi probe processes were stopped after verification.
Detailed local startup output is in ignored `.stage0/`, not committed. Probe
output includes only selected nonsecret state/command metadata. A delegated source
audit timed out without a report; the source findings were inspected directly and
are not described as independently reviewed.

## Reproduce

With existing dependencies/toolchains already installed:

```sh
npm run test:stage0
npm run build
(cd src-tauri && cargo fmt --all --check && cargo clippy --offline --locked --all-targets)
# Opt-in: normal extensions execute their startup hooks, but no LLM prompt is sent.
npm run probe:pi
npm run probe:pi:tui # POSIX; synthetic sessions + cancellation-only UI checks
```

If dependencies are absent, obtain approval before installing; tests do not install
them automatically. The probe needs Python 3 and the configured executable on PATH.

## What is NOT done

- Pi agent runtime or companion bridge implementation; agent defaults remain Claude.
- Exhaustive automation of live guardrail-policy, MCP, dashboard and host-specific
  extension paths. Kang accepted the normal live tool/extension-dialog workflows;
  the source-audited edge cases remain explicit runtime requirements.
- Authentication/origin hardening of the inherited local backend; isolation is not security.
- v2 document migration, process ownership, reliable flow delivery or other later-stage work.
- Changes to installed Pi extensions, credentials, project trust or global settings.
- New dependency installation, commit/push, signed/notarized app or published release.
  Unsigned local installation is implemented and exercised; see README commands.

## Native terminal editing follow-up

Kang reported visual-only editing defects in both upstream and the fork, including
at 100% zoom and with bare zsh. Adding backspace to the standalone probe reproduced
a missing-TERM failure: the display/cursor is wrong while the submitted command
is correct. Native PTYs now explicitly declare xterm capabilities. Rust regression,
19 total unit tests (8 stage-0 + 10 installer + 1 Rust), fmt/clippy and local
rebuild/install pass. Kang confirmed the fix works perfectly in-app and Pi loads.
The accepted manual round covered normal terminal operations, Pi launch, a safe
file tool, usual extension dialogs/overlays, Pi's own resume, and side-by-side
fork isolation. A plain terminal still does not automatically resume Pi after
app relaunch: its PTY is
ephemeral, plain `pi` starts a new session, and ccanvas does not yet persist or
manage Pi session identity. Manual `pi --continue`, `pi --resume`, or `pi
--session <path|id>` exercises Pi's own persistence; automatic exact resume is
later managed-runtime work. See [terminal-editing.md](terminal-editing.md) for
controls and evidence limits.

## Phase 0 result

**Accepted by Kang on 2026-09-24. Phase 1 is unblocked.** Transport direction is
settled: native Pi TUI plus a structured companion bridge, with RPC optional.
Phase 0 acceptance does not weaken the all-extensions requirement or turn the
manual checks into exhaustive automation; those constraints carry into the
managed runtime.
