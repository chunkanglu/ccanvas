# Pi extension compatibility — stage 0

## TL;DR

**Bare Pi RPC is not sufficient for the requested “all extensions work” gate.**
Normal-discovery startup succeeded with the requested launcher environment, but
several installed behaviors explicitly require TUI mode or custom components.
The integration mode **approved by Kang on 2026-09-24** is therefore **Pi TUI + a
companion structured event/control bridge**, with RPC available later as a
capability-limited optional surface. Native UI/synthetic-session tests now pass;
the production bridge is not implemented. A TUI alone also does not replace
dashboard- or terminal-host services. See [the native probe evidence](pi-tui-probe.md).

## Confirmed requirements

- Personal fork: `chunkanglu/ccanvas`.
- Launcher: `PI_TOOLS_IDLE_TIMEOUT_MS=6000000 pi` (not `mopi` as the primary launcher).
- Native terminal UI: desirable but not essential by itself.
- Preserve **all installed extension behavior**, not merely tool registration.
- App: ccanvas Pi, isolated from the upstream build.

## Startup probe evidence (2026-09-24)

`python3 scripts/probe-pi-rpc.py` uses the launcher in `fork.config.json`:

```text
program: pi
PI_TOOLS_IDLE_TIMEOUT_MS: 6000000
arguments: --mode rpc --no-session
resource discovery: normal (no --no-extensions/skills/context flags)
get_state: success
get_commands: success
extension_ui_request events: 3
invalid stdout JSONL records: 0
credential prompt detected: false
```

This probe sends **no model prompt, extension command, or tool invocation**.
Startup hooks do run. Stderr contained dashboard diagnostics, separately from
JSONL; raw output is not checked into git. The command list contained yaks,
intercom, tool-profile, guardrails settings/onboarding, MCP, and dashboard commands.
Registration is evidence of loading, **not** proof their complete behavior works.
No-session mode does not validate persistent session switching/resume.

Installed Pi reported **0.84.1**. Local package manifests reported guardrails
0.17.0, intercom 0.10.1, MCP adapter 2.24.0, dashboard 0.8.0,
anthropic-messages 0.3.4, and dashboard-extension 0.8.0.
These observations are dated, not permanent dependency pins for this project.

## Compatibility ledger

The paths below are installation-relative references, not vendored dependencies.
Package roots are under `~/.pi/agent/npm/node_modules/`; local extensions are
under `~/.pi/agent/extensions/`; guardrails is under
`~/.pi/agent/git/github.com/mechanical-orchard/pi-guardrails/`.

| Component | Source / evidence | RPC assessment and required work |
| --- | --- | --- |
| Guardrails path access | `extensions/path-access/index.ts:131` calls `ctx.ui.custom()` with no select fallback on that path | **Blocked for vanilla RPC interaction.** Pi RPC custom UI returns undefined; approval UX must not silently disappear. Keep TUI or provide a verified adapter. Do not disable guardrails to pass the gate. |
| Guardrails permission gate | `extensions/permission-gate/index.ts:112–131` tries custom UI, then `select()` | **Partial.** Select fallback can be supported, but must preserve deny/stop/session-grant semantics and be tested with installed UI proxies. |
| Guardrails settings/examples/onboarding | Custom-component commands, e.g. `extensions/guardrails/commands/onboarding/index.ts:27` | **TUI-dependent.** Merely listing commands in RPC does not make their UI work. |
| Guardrails Herdr integration | Package manifest includes `extensions/herdr/index.ts` | **Host-dependent, unverified.** ccanvas is not Herdr and must not claim its host integration. |
| pi-intercom | `index.ts:2367` explicitly returns unless `mode === 'tui'`; overlay custom components at 2400/2417 | **Partial.** Tool messaging may work; `/intercom` overlay does not in RPC. `/intercom-id` also depends on editor get/set behavior. Need a TUI or an explicit alternative UI. |
| pi-mcp-adapter | `init.ts:82–83` distinguishes TUI; `init.ts:135–139` sets URL elicitation `allowUrl: mode === 'tui'` | **Partial.** Metadata/commands register, but consent, sampling, auth, UI resources and URL elicitation need tests. Do not broadly call MCP RPC-compatible based on registration. |
| yak-tree | Local `yak-tree.ts:381` uses string-array `setWidget`; `/yaks` registered | **RPC-adaptable.** Implement widget lines, placement and commands; verify refresh/focus state. No full renderer test yet. |
| tool-profile-manager | Local `index.ts:356` calls `ui.confirm`; session restoration at 744 | **RPC-adaptable, unverified live.** Confirm needs cancellation/timeout fidelity and active-tool state must stay accurate. |
| toggle-tools | Local `toggle-tools.ts`; tool lifecycle hooks and user-idle timer | **Unverified behavior.** Requested idle-timeout env is passed unchanged. Test pause/resume and guardrail interaction; startup cannot verify a 100-minute timeout. |
| sub-agent-tool | Local `index.ts:117` spawns its configured `mopi` child | **External dependency remains.** Primary Pi launch does not change sub-agent launcher. A delegated audit timed out without a report; not a compatibility pass or proof that RPC caused the timeout. |
| fly-login-tool | Local `index.ts:237` calls `ui.confirm` | **RPC-adaptable, auth workflow untested.** Do not invoke credential helpers automatically for this audit. |
| git-remote-tool / shortcut / slack | Local tool extensions | **Unverified live tools.** No external account mutations or credential reads were performed. TUI replacement must preserve tool availability and policy, not silently omit them. |
| interrupt | Local command extension; `/interrupt` registered | **Registered only.** Actual story/notification side effects not invoked. |
| obsidian-daily | `obsidian-daily.ts:14–38` session-start hook creates a missing daily note | **No TUI dependency identified.** Startup has filesystem/CLI side effects; the probe is not side-effect-free just because no model prompt is sent. |
| cmux-session | Local `cmux-session.ts` hooks host events using cmux identity/env | **Host-specific.** A ccanvas agent is not automatically a cmux surface. Do not inherit a parent's host identity into unrelated agents; design host scoping. |
| pi-agent-dashboard + pi-dashboard-extension | Both configured; dashboard-extension `src/bridge.ts:2698+` registers adapters and patches UI methods | **Nontrivial UI routing.** Preserve the existing service integration and verify no duplicated interception. Core RPC dialogs alone are not the entire interface. |
| Dashboard ask_user and PromptBus | `src/bridge.ts:2760+` adds `inputWithImages`, `multiselect`, `batch`; `tui-prompt-adapter.ts:75–80` intentionally has no multiselect arm | **Requires dashboard/PromptBus integration.** These are not stock Pi RPC dialog methods. TUI alone does not render every dashboard-only interaction either. |
| pi-anthropic-messages | Configured package with `dist/index.js` extension entry | **Provider/bridge integration unverified.** Do not treat a get_state response as a provider request test. |
| Dashboard automation / flows / goal / flows-anthropic-bridge | Four configured local plugin bridge entrypoints | **Service-dependent, unverified.** Their event buses, controls and agent factories require separate acceptance cases; ccanvas arrows do not replace them. |

## Why the proposed primary mode changes

The initial HTML plan recommended RPC **conditional on workflow parity**.
The user's requirement is now explicit, and inspection found counterexamples:
intercom actively opts out of non-TUI mode, and guardrails uses custom components.
A general RPC renderer cannot execute arbitrary extension TUI factories.

Therefore:

1. Preserve the actual interactive Pi process, extension discovery and requested
   environment for the first full-fidelity integration.
2. Use a companion extension to export authoritative session/lifecycle/tool events
   and scoped controls, not terminal-output heuristics.
3. Keep dashboard integration running where installed; investigate PromptBus for
   optional in-canvas ask_user dialogs rather than assuming stock RPC covers it.
4. Keep the harness-neutral document/controller design. Substitute the Pi transport
   implementation; the same flow/tracker/roster consumers should not care whether
   events arrive from RPC or the companion bridge.
5. Offer structured RPC as optional later, with explicit capabilities and gaps, or
   after adapting every required extension behavior. Do not promise future third-
   party extensions are universally compatible without testing.

## Phase 0 acceptance cases

- Live prompt, a safe fixture read, and a known completed-run result under the real launcher.
- Interactive guardrails path request and permission deny/cancel/stop behavior.
- Intercom overlay and tool messaging; no unintended messages to other sessions.
- Yaks widget + tool-profile confirmation; idle protection remains active.
- Dashboard ask_user input/batch/multiselect routes and cancellation.
- MCP consent/elicitation/authorized tool use; service-specific tests only when approved.
- Session persistence, exact resume, new/fork/switch identity and host integration ownership.
- Packaged-app environment and native Pi rendering, not just CLI startup.

Kang subsequently confirmed the normal live path: safe file-read tooling, usual
extension dialogs/overlays, Pi's own resume, native terminal behavior and
side-by-side fork isolation all work in the installed app. He accepted phase 0
on 2026-09-24. Specialized service/host paths that were not independently
automated remain requirements for the managed runtime, not evidence that vanilla
RPC is sufficient.

## Additional native evidence — 2026-09-24

The normal-discovery PTY probe passes custom overlay and confirmation cancellation,
installed intercom overlay open/close, exact synthetic resume, new/switch/clone
identity and extension-marker restoration, and graceful exit. It refuses model
prompts and does not execute tools. The unsigned fork bundle also builds and
survives a 12-second launch, creating fork-specific WebKit/cache/log directories.
These results narrow the outstanding gate; they do not complete every row above.

## What is NOT done

No production companion bridge and no changes to installed extensions, trust,
credentials or user Pi config. The automated probe remains synthetic and does not
prove every policy/MCP/dashboard branch; manual acceptance covers the normal live
path only. Phase 0 is complete, and these limitations carry into later runtime
acceptance.
