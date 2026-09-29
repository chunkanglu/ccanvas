# Agents creating canvas panels

## Status

Implemented on `fork/agent-canvas-control`; installed-app acceptance pending.

## What it does

Pi agents get a `ccanvas` tool for building their own workspace next to themselves. It is not named `canvas`, because users may already have an unrelated `canvas` tool. Every panel they create is placed beside them, marked `↳ <agent>`, and automatically connected to them with an arrow. A spawned browser is therefore immediately drivable with `canvas_browser`.

| Action | Effect |
| --- | --- |
| `list` | This agent, what it spawned, what else is arrow-connected, and whether flows run |
| `spawn_agent` | A Pi agent in this agent's folder or a subfolder, inheriting its model/provider and color. An optional `prompt` starts it working once its runtime connects (`start: false` leaves it as a draft). `return_output` adds a flow arrow that sends its finished output back. |
| `spawn_browser` | A named web widget, optionally at an http(s) URL |
| `spawn_note` | A Markdown note |
| `spawn_file` | A viewer/editor for a file inside the agent's folder |
| `spawn_terminal` | A shell for the user, in the agent's folder or a subfolder |
| `connect` | An arrow between this agent and panels it spawned; agent-to-agent arrows may carry flow logic (`when`, `flow_prompt`) |
| `message` | Send a prompt to a spawned or connected agent (acknowledged; follow-up if busy) |
| `status` | Activity, run count, and last output line of spawned/connected agents |
| `close` | Remove a panel this agent spawned, with its arrows and runtime |

## Boundaries

- **Ownership:** agents connect, message, and close only themselves and panels they spawned (`message`/`status` also reach agents the user connected to them). An agent cannot draw an arrow into a panel you created, so it cannot grant itself access to your own browsers.
- **Own tab only:** actions apply to the agent's own canvas tab, even while you view another.
- **Folders:** agents, terminals, and files stay inside the spawning agent's folder; `..` and absolute paths outside it are refused.
- **Limits:** per agent, at most 6 spawned agents, 30 spawned panels, and 12 spawns per minute. Agents spawned by spawned agents cannot spawn further agents (depth 3).
- **Launch prompts** are one-shot runtime state, never saved into `.ccnvs`. After a restart the task remains an unsent draft, and opened canvases still require activation.
- **Flows:** `return_output` and flow arrows respect the global pause. Results return automatically only after you resume flows.
- Only Pi agents have the tool.
- **Always active in ccanvas agents:** `canvas_browser` and `ccanvas` are re-activated before each agent run, even when a tool-profile extension reset the active set. Otherwise the agent would re-enable them *during* a run. Pi records that as `addedToolNames`, and after a later switch to Anthropic every request can fail with `Tool reference 'canvas_browser' not found in available tools`. Sessions whose history already contains such a record are left as they are; see recovery below.

## Recovering an affected session

A session that hit `Tool reference '…' not found in available tools` keeps the problematic record in its history, so it fails on every Anthropic request. Use one of these:

- Use `/tree` to branch from a message *before* the agent enabled the tool.
- Deactivate the tool in that session, for example `tool_profile remove canvas_browser`, so Pi stops referencing it.
- Continue on the provider that was active when the tool was enabled (the recorded case worked on `openai-codex`).

## Limits

- A spawned agent starts only when its canvas tab is visible, as with any Pi agent.
- There is no "read another agent's full output" action; use `return_output` flows or `status`.
- Spawned agents cost model usage like any other session.
