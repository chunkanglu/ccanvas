# Phase 2 — managed Pi TUI and companion runtime

## TL;DR

Phase 2 is in progress. Its primary transport is the approved **native Pi TUI plus
a private structured companion channel**, not the original RPC-only sketch. The
protocol, companion extension, native Tauri manager, frontend transport, and an
explicit Pi choice in the agent wizard are implemented. Basic live managed-widget
acceptance passed. The post-review unsigned debug bundle is built and resource-checked;
the older installed build is still running, so guarded replacement is intentionally deferred.

## Current slice

`src/lib/pi-companion-protocol.ts` defines JSONL envelopes for:

- one capability-bearing hello and a host welcome with replay position;
- widget ID + monotonically increasing process generation on every frame;
- session, lifecycle, assistant-text, tool and runtime-error events;
- prompt/steer/follow-up, abort, rename and graceful-shutdown controls;
- correlated results and ping/pong health checks.

Frames are limited to 256 KiB. Replay is bounded to 512 events and 4 MiB. Strict
directional decoders reject reflected traffic, malformed JSON, protocol-version
mismatches, invalid identities/sequences, oversized/truncated frames, and a token
outside the hello frame. JSONL decoding handles arbitrary TCP and UTF-8 chunking.

`scripts/pi-companion-extension.ts` is inert unless a manager supplies a complete
numeric-loopback endpoint and high-entropy capability through dedicated environment
variables. It deletes those variables before tools or children can inherit them,
then retains the capability only in process memory so Pi extension reload/session
replacement can reconnect without exposing it. The extension:

- does not register tools/commands, patch UI, alter trust, or intercept guardrails;
- emits exact Pi session ID/file separately from widget/process identity;
- reports model/thinking, agent/turn/settled, text-delta and structured tool events;
- uses `agent_settled`, carrying the last known outcome, for settled state;
- reserves and fingerprints in-flight control IDs so simultaneous/conflicting
  duplicates cannot execute a semantic action twice;
- bounds socket backpressure and replay memory; oversized tool/text payloads are
  marked truncated by UTF-8 bytes rather than disrupting the native Pi run;
- keeps the process-level socket across extension-instance replacement, reconnects
  unexpected disconnects with bounded exponential backoff, and emits current-state
  reset snapshots after a replay gap;
- releases the old instance's control context, then flushes shutdown on quit.

## Native Tauri manager

`src-tauri/src/pi_runtime.rs` now owns managed Pi processes independently of normal
shell PTYs. It binds an ephemeral numeric-loopback listener before spawn, generates
a 256-bit capability from the OS, authenticates token + widget + backend generation
+ child PID without emitting the token, and passes only the listener metadata to
the explicit companion extension. It preserves normal Pi resource discovery and
removes inherited cmux/Pi-session identity before launch.

The manager assigns monotonic process generations and independent attachment leases,
separates workspace-runtime ID from portable widget ID, and rejects stale commands,
detaches, events, and superseded opens. Client intent epochs make delete/open/undo
races orderable even after a webview reload. Exact resume requires an existing
absolute session file only on spawn; an already-live process can reattach after that
file or cwd disappears. The configured executable is resolved without installation,
Unix candidates must be executable, and inherited cmux/Pi identity is removed rather
than merely overwritten.

PTY/event memory and socket writes are bounded; native frames are schema-validated
before sequence/replay mutation. Reattach emits replay-marked current session/lifecycle
snapshots rather than historical side effects. Gap recovery remains replay-marked
through its reset-complete event, reconstructing status without repeating metrics,
flows, or notifications. Widget deletion works without a cached frontend generation.
Shutdown signals freshly enumerated members of the stable launch session, escalates
without stale descendant PIDs, and reaps the direct child. Per-runtime PTY/companion
locks keep a wedged process from blocking the global manager.

The companion TypeScript sources are bundled as app resources. Debug builds use the
repository source when present; release builds require the packaged copy. Capability
generation currently supports Unix/macOS; Windows fails visibly rather than using
weak randomness.

`src/lib/pi-runtime.ts` installs and failure-cleans listeners before open, filters
every callback by runtime ID + generation + portable widget ID, buffers open-race
events, and exposes start/input/resize/control/detach/kill. Runtime transport/status
identity is workspace-scoped for every terminal/agent, so opening the same canvas
twice cannot cross-route prompts; owned registrations prevent stale cleanup from
unregistering a replacement. Submitted Pi prompts, flows and renames use structured
controls rather than typing into whichever native overlay owns stdin. Raw bytes remain
only for direct terminal interaction and explicit editable paste.

`PiTerminalBody.tsx` retains native xterm TUI, uses structured lifecycle/session/tool/
text events for status, persistence and flows, reconstructs replay without side effects,
and updates the owning tab even while hidden. Unchanged metadata snapshots do not mark
the canvas dirty. The agent wizard exposes Pi only explicitly; Claude remains default.
Provider-only/model-only launch settings are honored, and live process settings cannot
silently mutate.

## Verification

Seventeen Phase 2 tests cover protocol round trips/direction, split UTF-8, UTF-8 field
limits, malformed/oversized/token-leaking traffic, authenticated hello/welcome,
bounded replay plus gap reset and reconnect, environment cleanup, simultaneous and
conflicting control deduplication, semantic-control routing, workspace identity,
owned cleanup, open/delete/undo races, listener failure cleanup, stale generations,
and the packaged companion import closure. Eleven Rust tests additionally cover OS
capability strength, strict native decoding/truncated EOF, filtered environment,
provider/model arguments, bounded replay, replay recovery classification, exact-resume
rejection, stable launch-session cleanup/reaping, and terminal capabilities.

The full 40 JavaScript tests, TypeScript/Vite production build, Rust fmt/test/clippy
with warnings denied, diff check, raw native bundle and companion resource inspection
pass; the existing large-chunk warning remains. A guarded installation passed before
review fixes; the post-review bundle was not installed over the currently running app.

`npm run probe:pi:companion` also passes against the actual configured Pi 0.84.1
with normal resource discovery and two explicit instrumentation extensions. Using
a private synthetic session, it verifies capability authentication, exact session
ID/file reporting, rename and idle-abort acknowledgments, native custom-overlay
cancellation, structured shutdown, and clean process exit. It sends no model prompt
or tool call; installed extensions still run their normal startup hooks.

## Security boundary

The native host binds an ephemeral listener to `127.0.0.1` before spawning Pi,
generates a fresh per-runtime capability, compares it without logging it, permits one
active connection for the matching widget/generation/process, publishes control state
only after flushing welcome, and rejects frames before hello authentication. This
channel is not attached to the inherited
unauthenticated Node HTTP/WebSocket bridge. Same-user process inspection remains an
OS-level limit, not something this local capability can defeat.

## What is NOT done

No web runtime manager or Windows capability generator/job-object ownership. Basic
native in-app launch/input/extension-overlay behavior and exact app-restart resume
were accepted before the independent review; the hardened post-review build still
needs installation after the running app is quit and targeted live checks for forced
reconnect overflow, delete/undo, semantic prompting over an active overlay, and tree
cleanup. The CI suite verifies the resource mapping/import closure, while a CI-produced
platform bundle smoke job remains a pre-release follow-up. Phase 3's richer settings
and composer are not implemented. Claude remains default. No release has been made.
