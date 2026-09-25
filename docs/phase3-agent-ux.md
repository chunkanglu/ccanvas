# Phase 3: native Pi agent UX

Phase 3 makes the managed Pi agent comfortable to use from ccanvas without replacing Pi's native terminal UI. The original roadmap assumed an RPC-rendered `PiAgentBody`; Phase 2 instead established native Pi TUI + an authenticated structured companion as the compatibility boundary. This document is the Phase 3 rebaseline.

## Boundary

Pi continues to render its own transcript, streaming text, tool calls, selectors, confirmations, editors, extension widgets, status/footer, and command UI inside xterm. ccanvas must not duplicate those surfaces or send semantic actions as terminal bytes while a native overlay may own input.

ccanvas adds only host-level workflows that benefit from canvas integration:

- a persistent, reviewable prompt draft and acknowledged semantic submit;
- explicit `steer` versus `follow-up` delivery while a run is active;
- active-run abort without killing the process;
- acknowledged live model, thinking-level, and active-tool settings exposed by the companion;
- a branch-aware Pi transcript widget for canvas/roster use, sourced from the exact session file rather than terminal scraping.

Harness, cwd, executable, project trust, and OS sandbox configuration are not live settings. Changing them requires an explicit new runtime/session. Claude `skipPermissions` is never translated into Pi trust or tool policy.

## Slices

### 3A — persistent composer

The Pi widget gets a ccanvas composer adjacent to the terminal. Draft text is portable workspace state and survives save/reopen. Prompt-library insertion remains an editable paste/draft operation; it never implies submission.

When Pi is idle, Send starts a run. When Pi is working or waiting, the user explicitly chooses:

- **Follow up** (default): queue after the current response.
- **Steer**: inject at the next steering boundary.

The companion result is the acceptance boundary. Rejected/offline/timeout text remains in the draft with a visible error. A successful result clears the draft. Abort cancels the active run; it does not terminate Pi or resend anything.

### 3B — live settings

The companion publishes bounded catalogs containing canonical provider/model references, supported thinking levels, and configured/active tools. Settings controls use structured requests and update portable widget state only after acknowledgment plus the resulting session/catalog snapshot.

Model selection resolves an exact canonical `provider/model` reference against Pi's scoped models. Bare ambiguous model IDs are rejected. Tool changes contain only names already reported by Pi. No setting grants project trust, bypasses a guardrail, or changes local credentials.

### 3C — transcript and shared views

The native TUI remains the primary transcript. A canvas transcript view reads the exact persisted Pi session file and preserves branch/compaction semantics. It labels active context versus branch history, bounds retained/rendered data, and does not concatenate abandoned branches. Roster status, rename, notifications, and broadcast continue through the workspace-scoped structured transport delivered in Phase 2.

## Implementation status

The first implementation is on `fork/phase3-agent-surface`:

- Pi widgets have a persistent host composer with correlated Send/Steer/Queue/Abort results and an authoritative pending-queue indicator from `ctx.hasPendingMessages()`. Edits made while a result is pending are not erased. Prompt-library and dropped unsubmitted text route into this draft instead of native overlay stdin.
- The companion publishes bounded, replayable model/tool catalogs and accepts idle-only model, thinking, active-tool-set, and individual tool-toggle controls. Model references are exact provider/id pairs; unavailable models/tools and missing credentials reject without changing portable state. Tool toggles preserve active tools omitted by the bounded display catalog.
- The settings panel persists only authoritative session snapshots, including a model-clamped thinking level; it never changes trust, credentials, cwd, or sandboxing.
- Pi session events carry the current tree leaf. The transcript parser follows parent links from that leaf, excludes abandoned siblings, does not materialize `retainedTail` over existing messages, labels compaction/branch context, and bounds parsed entries, rendered turns, and individual text.
- Roster delivery awaits each Pi result, reports per-target failures, retains rejected text, and retries only failed targets rather than duplicating accepted broadcasts.

Automated evidence includes 17 Phase 2 protocol/runtime tests, 3 Phase 3 state/tree/drop tests, 12 Rust tests, TypeScript/Vite build, Rust fmt/clippy, the actual no-model Pi companion probe, installer coverage, and diff checks. Installed-app acceptance passed composer persistence, idle send, prompt insertion, live settings, follow-up queue, steering, abort, native-overlay isolation, transcript, roster delivery, exact resume, and file-to-draft insertion. The file test exposed WKWebView suppressing native HTML drag start inside the transformed canvas; file-tree and diff rows now use bounded app-local pointer tracking with explicit drop targets, while prompt rows retain native DnD.

## Exit gate

On the final installed app:

1. Create a Pi agent and retain an unsent draft across save/reopen.
2. Send while idle, steer while active, queue a follow-up, abort, and retry a rejected prompt without losing text.
3. Rename and change model/thinking/tools with acknowledgments and visible current state.
4. Use prompt-library insertion plus a skill/command through native Pi.
5. Exercise native select/confirm/input/editor and required extensions without ccanvas overlay interference.
6. Reload while streaming and while a native dialog is open; no prompt repeats and roster state remains workspace-scoped.
7. Open a Pi transcript and distinguish active branch history correctly.

Pi remains opt-in and Claude behavior remains unchanged until later parity/default gates.
