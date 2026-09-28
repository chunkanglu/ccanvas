# Agents driving canvas browsers

## Status

Implemented on `fork/agent-browser-control`; installed-app acceptance pending.

## Why not browser-use itself

`browser-use` drives Chromium through the Chrome DevTools Protocol (CDP). Canvas browsers are native WebKit portals, which have no CDP endpoint, so browser-use cannot attach to them. Emulating CDP over WebKit would be large and fragile.

Instead, Pi agents get a native `canvas_browser` tool with browser-use's workflow: list browsers, snapshot the page with element refs, act by ref, and snapshot again.

## How it works

1. **Name the browser.** Every web widget has a browser name shown in its bar. New widgets get `browser`, `browser-2`, and so on; the name is editable and unique per canvas. Older widgets get a stable id-based name until renamed.
2. **Connect it.** Draw an arrow between a Pi agent and a web widget, in either direction. Selecting the arrow explains the grant. The web widget shows which agents can drive it and pulses while one acts.
3. **The agent uses `canvas_browser`.** The companion registers the tool only inside ccanvas-managed Pi, and Pi lists it among the agent's active tools. Each call becomes a non-replayed `tool_request` frame.
4. **The host decides access.** The canvas resolves browsers connected to that agent by arrows in that agent's tab, and matches the requested name. The Pi process never sees canvas state and cannot address unconnected browsers.
5. **Actions run in the page.** The host injects synchronous helpers into the portal through WebKit `evaluateJavaScript` (`portal_eval`) and returns bounded text to the model.

| Action | Effect |
| --- | --- |
| `list` | Connected browser names and URLs |
| `info` | URL, title, load and scroll state |
| `snapshot` | Page text plus visible interactive elements with refs (`[e12] button "Sign in"`); passwords are masked |
| `click`, `fill`, `select` | Act on a ref; `fill` can `submit` its form |
| `press` | Key on a ref or the focused element (Enter submits inputs' forms) |
| `scroll` | `up`/`down` by viewport fraction, `top`/`bottom` |
| `goto`, `back`, `forward`, `reload` | Navigate and wait for load; `goto` opens an empty browser |
| `wait` | For page load or visible text |
| `js` | Evaluate a synchronous expression; JSON result |

## Deferred decision

**Chromium engine (2026-09-28): kept native WebKit for now.** Tauri renders with WebKit on macOS and WebKitGTK on Linux, so neither is Chromium-based; Tauri's CEF runtime is unreleased. If Chrome-engine or Linux support is revived, the recommended spike is streaming a CDP-controlled installed Chrome into DOM widgets. That would give trusted input, screenshots, cross-platform behavior, and optional browser-use attachment, at the cost of streaming latency and possible sign-in blocking. An Electron shell is the fallback.

## Limits

- Input is synthetic DOM events (`isTrusted: false`). Most sites work, but some that require trusted input, drag-and-drop, file pickers, or canvas-rendered UIs do not.
- No screenshots yet. Snapshots are text, because WebKit snapshotting requires new native bindings.
- Cross-origin iframes and closed shadow roots are not traversed.
- The agent acts in your real logged-in session. Its tool guidance asks it to stop before passwords, payments, messages, or irreversible changes, but that guidance is not an enforcement boundary. Only connect browsers you are willing to let the agent operate.
- Pages can include misleading text (prompt injection); treat agent actions on untrusted sites accordingly.
- Only Pi agents are supported. Claude agents connected by arrows cannot drive browsers.
