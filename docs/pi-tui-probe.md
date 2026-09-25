# Native Pi probe and accepted transport

## TL;DR

**Accepted by Kang on 2026-09-24:** primary Pi integration will retain the native
TUI and add a structured companion event/control bridge. RPC remains optional.
The stage-0 PTY probe demonstrates native custom UI and synthetic-session
lifecycle with normal extension discovery. **It is test instrumentation, not the
production bridge, and it does not call a model or execute tools.**

## Short version

Run `npm run probe:pi:tui` on macOS/Linux with existing Pi/Python installations.
It starts the configured `pi` with `PI_TOOLS_IDLE_TIMEOUT_MS=6000000`, adds one
explicit test extension, and uses private synthetic sessions under `.stage0/`.

Observed passing on 2026-09-24 with Pi 0.84.1:

1. Native `ctx.mode === 'tui'`, `ctx.hasUI === true`, requested idle timeout.
2. Exact synthetic session resume (not a recent-session guess).
3. Custom overlay rendering and Escape cancellation.
4. Confirmation through the installed UI stack returning false on Escape.
5. Installed `/intercom` overlay opening and closing without messaging anyone.
6. New/switch lifecycle, original identity restored, persisted custom marker retained.
7. Clone gets a new identity, retains marker; graceful process shutdown.

The first attempt exposed an automation timing issue: bare Escape and the next
paste must not share the terminal input debounce window. After draining UI work
between commands, two consecutive runs passed. This was not an extension fix.

## Safety and evidence boundaries

- No `--no-extensions`, replacement home/config directory, permission flags or
  project-trust overrides. The installed extension stack is still loaded.
- The explicit test extension logs selected metadata only. It does not replace
  tools, patch UI methods, modify policies or add a network listener. It refuses
  non-command input to prevent accidental LLM requests during automation.
- `PI_OFFLINE=1` suppresses Pi startup checks/telemetry. It is **not a network
  sandbox**: extensions still run normal hooks and may connect to their services.
  Observed startup side effect: the dashboard created `.pi/dashboard/kb/index.db`;
  that generated cache is now narrowly gitignored, not deleted. Future project
  extension/settings sources remain visible to git.
- Parent `CMUX_*` surface identity and Pi session metadata are removed from the
  probe child. A canvas-owned terminal must not impersonate its parent's cmux
  surface or session. The cmux extension remains installed; this is not evidence
  of cmux-host feature parity in ccanvas.
- The prior assistant message is **synthetic**, clearly labeled in the fixture.
  Resume/clone passing is not evidence of a model response or live transcript fidelity.
- Raw terminal output and peer details are not written to the report. Evidence
  stays in private `.stage0/tui-*` directories; no real session is opened.
- The PTY driver answers cursor-position queries, sends explicit slash commands
  and cancellation keys only. Credential/trust prompts stop the test unanswered.
- `npm run test:stage0` also tests instrumentation privacy, file permissions,
  cancellation, accidental-input refusal and idempotent teardown using a mock API.
  These unit tests do not launch Pi.

## Companion bridge constraints for the runtime stage

- **Separate data channels:** PTY carries presentation/input; companion channel
  carries structured session, tool and lifecycle events. Never interpret ANSI,
  idle screen time or arbitrary OSC output as authoritative agent status.
- **Ownership:** canvas widget identity, process generation, Pi session ID and
  session path are distinct. Exact resume only; missing paths must fail visibly,
  not silently resume a different conversation.
- **Lifecycle:** Pi 0.84.1 reload/new/resume/fork tear down and recreate extension
  instances. Close old resources on `session_shutdown`, recreate on
  `session_start`, and reject controls from stale generations.
- **Completion:** `agent_end` may precede retries/compaction/queued work. Use
  `agent_settled` for settled status, plus explicit outcome/error information for
  flow completion. Acknowledgment is not an exactly-once guarantee.
- **Security before control endpoints:** per-runtime capability, private IPC,
  owner-bound messages, bounded frames/replay and explicit disconnection. Do not
  attach unauthenticated Pi controls to the existing permissive Node bridge.
- **Coexistence:** do not replace the global Pi config or intercept guardrail
  decisions. Native dialogs remain native. Dashboard-only PromptBus controls need
  their service integration, not an invented stock-RPC approximation.
- **Native PTY review work:** the Rust PTY now overrides inherited terminal
  capabilities with `TERM=xterm-256color`/`COLORTERM=truecolor`; Kang confirmed
  the resulting editing/rendering fix. Before managed Pi runtime adoption, still
  test broader environment scoping, stale-exit cleanup, replay ordering and
  descendant termination.

## Unsigned native app check

The initial local debug bundle was built without signing, installation or dependency downloads:

```sh
CARGO_NET_OFFLINE=true ./node_modules/.bin/tauri build \
  --debug --bundles app --no-sign --ci -- --offline --locked
```

Artifact: `src-tauri/target/debug/bundle/macos/ccanvas Pi.app`.
Its Info.plist has the fork title and identifier. The bundled executable remained
alive for a 12-second smoke run, created fork-specific WebKit/cache/log directories,
and was then stopped. No startup stderr/stdout was emitted.

## What is NOT done

The automated probe still does not make a live LLM/file-tool request, exercise
every guardrail/dashboard/MCP branch, or prove sub-agent success. Kang separately
accepted the normal live tool/extension, Pi resume, native GUI and side-by-side
paths in the installed app. No production companion IPC, agent default switch,
push or release exists. `npm run app:install` and `npm run app:build` install and
register successful local macOS builds in `~/Applications`; Spotlight discovery
is verified. Phase 0 is complete, while these automation gaps remain later-stage
runtime acceptance constraints.
