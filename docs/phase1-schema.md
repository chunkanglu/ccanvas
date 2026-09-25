# Phase 1 — harness-neutral schema and controller

## TL;DR

Phase 1 is complete and manually accepted. It adds `.ccnvs` v2, explicit
`harness: "claude" | "pi"`, separate durable session ID/file fields, Pi model
provider/thinking/tool-profile configuration, and a transport-neutral controller
contract. Existing v1 agents migrate to Claude without changing their session IDs.
New agents still default to Claude; a loaded Pi record shows an unavailable-state
message and cannot accidentally launch Claude before the phase 2 runtime exists.

## Schema and migration

- `.ccnvs` writes version 2; versions 1 and 2 load.
- A missing, invalid, or unknown harness fails closed to `claude`.
- `provider` is the LLM provider inside a harness, never the harness discriminator.
- `sessionId`, `sessionFile`, canvas widget ID, and process generation are distinct.
- Pi trust, authentication, credentials, runtime capabilities, and process state are
  intentionally not portable canvas configuration.
- Fork-local autosave/templates move from `:v1` to `:v2` keys on first successful
  read. Legacy entries remain untouched as rollback evidence.
- Templates preserve harness/model settings but never copy durable session identity.
  Pasted agents also receive fresh identities.

## Controller boundary

`src/lib/agent-controller.ts` defines launch specs, capabilities, normalized events,
controls, handles, and the controller interface that phase 2 transports implement.
The generation/sequence gate rejects stale process events, duplicates, out-of-order
frames, invalid sequence numbers, and generation reuse even after detach. Sequence
numbers provide ordering, not exactly-once delivery.

## Verification

- Ten isolation/schema migration tests pass.
- Three controller identity/generation tests pass.
- Ten guarded installer tests pass.
- TypeScript and production Vite build pass with the pre-existing large-chunk warning.
- The phase 1 native build installed successfully, and Kang confirmed existing
  Claude agents still work.

## What is NOT done

No managed Pi process, companion IPC, Pi agent creation UI, default switch, transcript,
flows, or runtime controls. Those remain phase 2+ work. Phase 1 is committed
separately after the phase 0 baseline `025753d`; neither commit was pushed during
local acceptance.
