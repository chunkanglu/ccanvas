# Phase 4 — provider-neutral flows and tracking

## Status

Implemented and accepted on `fork/phase4-flows-tracking`. Pi remains opt-in and the native Pi TUI remains the primary interaction surface.

Installed-app acceptance passed A→B→C, repeated runs, abort isolation, text-failure versus run-error separation, busy-target follow-up, AND/OR joins, graph-edit invalidation, pause/re-arm, restart without replay dispatch, successful/failed/sensitive file tracking, and Stop/Stop & clear. Acceptance found two defects, both fixed and retested: tracked viewers now use the companion's Pi-compatible absolute path and refresh clean editors after tracked edits; flow-arrow text fields reset when switching directly between connectors.

Automated evidence: Stage 0 10, Phase 1 3, Phase 2 17, Phase 3 3, Phase 4 9, installer 10, Rust 12, TypeScript/Vite build, Rust fmt/clippy with warnings denied, actual no-model Pi companion probe, and diff checks.

## Decisions

### Settled run, not quiet terminal

Pi flow evaluation begins only from a non-replayed companion `agent_settled` event. One run record contains:

- workspace-scoped widget identity and process generation;
- a process-scoped run ID assigned before `agent_start`;
- terminal outcome: `completed`, `failed`, or `aborted`;
- the bounded final assistant message used both for conditions and `{{output}}` piping.

`agent_end` and model `turn_end` are intermediate evidence. Replayed lifecycle snapshots, disconnects, incomplete runs, and aborts never synthesize successful completion. Claude retains its existing quiet-screen compatibility adapter, but that adapter produces the same internal settled-run shape and remains visibly heuristic.

Run outcome and task result remain separate. `success` and `failure` continue to be text heuristics (or explicit regexes) over completed output. A separate `runtime-error` condition handles a failed Pi run. `always` means a completed run, not every process stop.

### Delivery certainty

Each dispatch gets a stable ID derived from graph revision, source run, contributing edges, and target. Delivery state is one of:

- `pending`: no result yet;
- `accepted`: the target acknowledged the semantic prompt;
- `rejected`: the target definitively refused it;
- `offline`: no write was attempted;
- `uncertain`: ccanvas may have written the control but lost its acknowledgement.

Offline targets may be rechecked before the first write. Rejected and uncertain deliveries are never blindly resent. Uncertain delivery is surfaced for deliberate reconciliation/resend. Pi uses the delivery ID as its companion request correlation ID; this is in-process dedupe evidence, not durable exactly-once delivery.

A frontend reload starts with flows paused. Replayed runtime state is for reconciliation only. The user explicitly re-arms automatic dispatch after reconnecting.

### Joins and graph edits

Join bookkeeping is scoped by workspace, a deterministic graph revision, target, and a fresh target execution epoch. Graph changes and pause reset pending satisfactions. Within one epoch the first completion for an incoming edge wins; a later run cannot silently overwrite it while other edges are pending. Consuming an AND/OR join advances the target epoch.

Every asynchronous boundary rechecks that flows remain armed and that the graph revision is unchanged. Pause, deletion, and graph edits prevent late work from creating a new dispatch.

### Structured Pi file tracking

Pi tracking consumes non-replayed structured `tool_execution_start`/`tool_execution_end` pairs for the active process generation. The companion resolves built-in file-tool paths with Pi 0.84-compatible `@`, `~`, `file://`, and runtime-cwd rules, then sends a bounded absolute `resolvedPath` on the start event. Built-in mappings are explicit:

- `read` → successful read of `args.path`;
- `write` → successful mutation of `args.path`;
- `edit` → successful mutation of `args.path`.

Failed calls, unmatched ends, replay, arbitrary shell commands, and unmapped custom tools do not open viewers. Paths resolve against the runtime cwd. Sensitive credential/key paths are refused before a viewer opens. Existing orbit placement, viewer adoption, dedupe, 20-file cap, follow camera, Stop, and Stop & clear remain unchanged. Claude continues transcript polling.

## Acceptance gate

Automated tests cover:

- completed/failed/aborted/replayed settled runs;
- exact final-text condition and piping behavior;
- stable delivery IDs and accepted/rejected/offline/uncertain handling;
- duplicate settlement, pause, graph edit, and late acknowledgement;
- AND/OR target epochs and runaway protection;
- structured read/write/edit success, failure, replay, generation change, path resolution, dedupe, and sensitive-path filtering;
- retained Claude flow/tracking compatibility.

Installed-app checks cover A→B→C, AND and OR joins, sentinel match, busy-target follow-up, abort/failure isolation, pause during delivery, graph edit, and Pi file orbit behavior. Each intended prompt is accepted once or explicitly marked uncertain; it is never silently repeated.

## What is not done

- No unattended orchestration after the frontend exits.
- No claim that companion request IDs provide durable idempotency across process failure.
- No shell-command path guessing or child-agent file attribution.
- No web managed-Pi control path before origin/auth hardening.
