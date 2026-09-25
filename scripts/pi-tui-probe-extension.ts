/** Opt-in stage-0 instrumentation, NOT the production companion bridge.
 * No tools, prompt injection, trust overrides, UI patching, or network listeners.
 * Logs only selected metadata to an existing private file supplied by the probe.
 */
import { closeSync, constants, fstatSync, openSync, writeSync } from 'node:fs'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

export default function (pi: ExtensionAPI) {
  const path = process.env.CCANVAS_PROBE_LOG
  const fixture = process.env.CCANVAS_PROBE_SESSION
  if (!path || !fixture) throw new Error('Use scripts/probe-pi-tui.py to run this probe')
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW)
  const stat = fstatSync(fd)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    closeSync(fd)
    throw new Error('Probe log must be a private regular file')
  }
  let closed = false
  const record = (type: string, data: Record<string, unknown> = {}) => {
    if (!closed) writeSync(fd, JSON.stringify({ type, ...data }) + '\n')
  }
  const snapshot = (ctx: ExtensionContext) => ({
    mode: ctx.mode,
    hasUI: ctx.hasUI,
    sessionId: ctx.sessionManager.getSessionId(),
    idleTimeout: process.env.PI_TOOLS_IDLE_TIMEOUT_MS,
    activeTools: pi.getActiveTools(),
    commands: pi.getCommands().filter(c => c.source === 'extension').map(c => c.name),
    markerRestored: ctx.sessionManager.getBranch().some(e =>
      e.type === 'custom' && e.customType === 'ccanvas-stage0-marker'),
  })
  pi.on('session_start', (event, ctx) => record('session_start', { reason: event.reason, ...snapshot(ctx) }))
  pi.on('session_shutdown', event => {
    record('session_shutdown', { reason: event.reason })
    if (!closed) { closed = true; closeSync(fd) }
  })
  // Extension commands bypass `input`. Refuse every other prompt so mistyped
  // automation cannot accidentally invoke a model; this probe is UI-only.
  pi.on('input', () => { record('unexpected_input'); return { action: 'handled' } })
  pi.on('before_agent_start', (_event, ctx) => { record('unexpected_agent_start'); ctx.abort() })
  pi.registerCommand('ccanvas-probe', {
    description: 'Stage-0 local smoke-test instrumentation (no model requests)',
    handler: async (action, ctx) => {
      if (action === 'snapshot') { record('snapshot', snapshot(ctx)); return }
      if (action === 'custom') {
        record('custom_open')
        const result = await ctx.ui.custom<string>((_tui, _theme, keys, done) => ({
          render: width => ['CCANVAS PROBE: Escape cancels this test overlay'.slice(0, width)],
          invalidate() {},
          handleInput(data) { if (keys.matches(data, 'tui.select.cancel')) done('cancelled') },
        }), { overlay: true, overlayOptions: { width: 56 } })
        record('custom_result', { result: result ?? null })
        return
      }
      if (action === 'confirm') {
        record('confirm_open')
        const result = await ctx.ui.confirm('CCANVAS PROBE', 'Select No or Escape; no action will run.')
        record('confirm_result', { result })
        return
      }
      if (action === 'mark') {
        pi.appendEntry('ccanvas-stage0-marker', { synthetic: true })
        record('marked', snapshot(ctx)); return
      }
      if (action === 'new') { await ctx.newSession(); return }
      if (action === 'switch') { await ctx.switchSession(fixture); return }
      if (action === 'fork') {
        const leaf = ctx.sessionManager.getLeafId()
        if (!leaf) throw new Error('No fixture leaf to clone')
        await ctx.fork(leaf, { position: 'at' }); return
      }
      if (action === 'quit') { ctx.shutdown(); return }
      record('unknown_probe_action')
    },
  })
}
