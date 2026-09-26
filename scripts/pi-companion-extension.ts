/**
 * Structured companion for a managed Pi TUI process.
 *
 * This extension is inert unless a ccanvas-owned runtime provides a complete
 * private loopback capability configuration. It never patches Pi UI, registers
 * tools/commands, changes trust, or replaces native extension dialogs.
 */
import { createConnection, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  PI_COMPANION_MAX_REPLAY_BYTES,
  PI_COMPANION_MAX_REPLAY_EVENTS,
  PiCompanionFrameDecoder,
  decodeCompanionInboundFrame,
  encodePiCompanionFrame,
  type CompanionControl,
  type CompanionEventPayload,
  type CompanionResult,
  type PiCompanionFrame,
  type RuntimeIdentity,
} from '../src/lib/pi-companion-protocol'

type Config = RuntimeIdentity & { host: '127.0.0.1'; port: number; token: string }
type ReplayEntry = { seq: number; encoded: string; bytes: number }
type ControlHandler = (control: CompanionControl) => Promise<void>
type ControlRecord = {
  fingerprint: string
  completion: Promise<string>
  completed: boolean
}

type ProcessRuntime = {
  config: Config
  nextSeq: number
  replay: ReplayEntry[]
  replayBytes: number
  socket?: Socket
  decoder?: PiCompanionFrameDecoder
  authenticated: boolean
  owner: number
  controlHandler?: ControlHandler
  results: Map<string, ControlRecord>
  sessionSnapshot?: CompanionEventPayload
  lifecycleSnapshot?: CompanionEventPayload
  catalogSnapshot?: CompanionEventPayload
  queueSnapshot?: CompanionEventPayload
  statsSnapshot?: CompanionEventPayload
  nextRun: number
  currentRunId?: string
  currentAssistantText: string
  assistantTextTruncated: boolean
  reconnectAttempt: number
  reconnectTimer?: ReturnType<typeof setTimeout>
  stopping: boolean
}

const GLOBAL_KEY = Symbol.for('ccanvas.pi.companion.runtime.v1')
const ENV_KEYS = [
  'CCANVAS_COMPANION_HOST',
  'CCANVAS_COMPANION_PORT',
  'CCANVAS_COMPANION_TOKEN',
  'CCANVAS_COMPANION_WIDGET_ID',
  'CCANVAS_COMPANION_GENERATION',
] as const

function readConfig(): Config | null {
  const values = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  const present = ENV_KEYS.filter(key => values[key] !== undefined)
  if (!present.length) return null
  try {
    if (present.length !== ENV_KEYS.length) throw new Error('Incomplete ccanvas companion environment')
    const host = values.CCANVAS_COMPANION_HOST
    const port = Number(values.CCANVAS_COMPANION_PORT)
    const token = values.CCANVAS_COMPANION_TOKEN!
    const widgetId = values.CCANVAS_COMPANION_WIDGET_ID!
    const generation = Number(values.CCANVAS_COMPANION_GENERATION)
    if (host !== '127.0.0.1') throw new Error('Companion host must be numeric loopback')
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid companion port')
    if (!/^[A-Za-z0-9_-]{43,512}$/.test(token)) throw new Error('Invalid companion capability')
    if (!widgetId || widgetId.length > 256 || /[\u0000-\u001f\u007f]/.test(widgetId)) throw new Error('Invalid companion widget id')
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Invalid companion generation')
    return { host, port, token, widgetId, generation }
  } finally {
    // Do not leak the capability or canvas identity to tools/child processes.
    for (const key of ENV_KEYS) delete process.env[key]
  }
}

function state(): ProcessRuntime | null {
  const root = globalThis as typeof globalThis & { [GLOBAL_KEY]?: ProcessRuntime }
  if (root[GLOBAL_KEY]) return root[GLOBAL_KEY]!
  const config = readConfig()
  if (!config) return null
  return (root[GLOBAL_KEY] = {
    config,
    nextSeq: 0,
    replay: [],
    replayBytes: 0,
    authenticated: false,
    owner: 0,
    results: new Map(),
    nextRun: 0,
    currentAssistantText: '',
    assistantTextTruncated: false,
    reconnectAttempt: 0,
    stopping: false,
  })
}

const bytes = (value: string): number => Buffer.byteLength(value, 'utf8')
const truncateUtf8 = (value: string, maxBytes: number): string => {
  if (bytes(value) <= maxBytes) return value
  let result = ''
  let used = 0
  for (const character of value) {
    const size = bytes(character)
    if (used + size > maxBytes) break
    result += character
    used += size
  }
  return result
}

const truncateUtf8Tail = (value: string, maxBytes: number): string => {
  if (bytes(value) <= maxBytes) return value
  let result = ''
  let used = 0
  const characters = Array.from(value)
  for (let index = characters.length - 1; index >= 0; index--) {
    const character = characters[index]
    const size = bytes(character)
    if (used + size > maxBytes) break
    result = character + result
    used += size
  }
  return result
}

function sameRuntime(runtime: ProcessRuntime, frame: RuntimeIdentity): boolean {
  return frame.widgetId === runtime.config.widgetId && frame.generation === runtime.config.generation
}

function write(runtime: ProcessRuntime, encoded: string, beforeAuthentication = false): void {
  const socket = runtime.socket
  if (!socket || socket.destroyed || (!beforeAuthentication && !runtime.authenticated)) return
  if (socket.writableLength + bytes(encoded) > PI_COMPANION_MAX_REPLAY_BYTES) {
    socket.destroy(new Error('Companion socket backpressure limit exceeded'))
    return
  }
  try { socket.write(encoded) } catch (error) {
    socket.destroy(error instanceof Error ? error : new Error(String(error)))
  }
}

function encodedResult(runtime: ProcessRuntime, requestId: string, ok: boolean, error?: string): string {
  const frame: CompanionResult = {
    v: 1,
    type: 'result',
    widgetId: runtime.config.widgetId,
    generation: runtime.config.generation,
    requestId,
    ok,
    ...(error ? {
      error: truncateUtf8(error.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '�'), 8192),
    } : {}),
  }
  return encodePiCompanionFrame(frame)
}

function makeRoomForResult(runtime: ProcessRuntime): boolean {
  if (runtime.results.size < PI_COMPANION_MAX_REPLAY_EVENTS) return true
  for (const [requestId, record] of runtime.results) {
    if (!record.completed) continue
    runtime.results.delete(requestId)
    return true
  }
  return false
}

function dispatch(runtime: ProcessRuntime, frame: CompanionControl): void {
  const fingerprint = JSON.stringify(frame.control)
  const prior = runtime.results.get(frame.requestId)
  if (prior) {
    if (prior.fingerprint !== fingerprint) {
      write(runtime, encodedResult(runtime, frame.requestId, false, 'Request id reused with different control'))
      return
    }
    void prior.completion.then(encoded => write(runtime, encoded))
    return
  }
  if (!makeRoomForResult(runtime)) {
    write(runtime, encodedResult(runtime, frame.requestId, false, 'Too many in-flight companion controls'))
    return
  }

  let record: ControlRecord
  const completion = (async () => {
    if (!runtime.controlHandler) return encodedResult(runtime, frame.requestId, false, 'Pi extension context is not ready')
    try {
      await runtime.controlHandler(frame)
      return encodedResult(runtime, frame.requestId, true)
    } catch (error) {
      return encodedResult(runtime, frame.requestId, false, error instanceof Error ? error.message : String(error))
    }
  })()
  record = { fingerprint, completion, completed: false }
  runtime.results.set(frame.requestId, record)
  void completion.then(encoded => {
    record.completed = true
    write(runtime, encoded)
  })
}

function scheduleReconnect(runtime: ProcessRuntime): void {
  if (runtime.stopping || runtime.reconnectTimer || (runtime.socket && !runtime.socket.destroyed)) return
  const exponent = Math.min(runtime.reconnectAttempt++, 7)
  const delay = Math.min(30_000, 250 * (2 ** exponent)) + Math.floor(Math.random() * 250)
  runtime.reconnectTimer = setTimeout(() => {
    runtime.reconnectTimer = undefined
    connect(runtime)
  }, delay)
  runtime.reconnectTimer.unref?.()
}

function connect(runtime: ProcessRuntime): void {
  if (runtime.stopping || (runtime.socket && !runtime.socket.destroyed)) return
  if (runtime.reconnectTimer) {
    clearTimeout(runtime.reconnectTimer)
    runtime.reconnectTimer = undefined
  }
  runtime.authenticated = false
  const decoder = new PiCompanionFrameDecoder(decodeCompanionInboundFrame)
  runtime.decoder = decoder
  const socket = createConnection({ host: runtime.config.host, port: runtime.config.port })
  runtime.socket = socket
  socket.setNoDelay(true)
  socket.on('connect', () => {
    write(runtime, encodePiCompanionFrame({
      v: 1,
      type: 'hello',
      widgetId: runtime.config.widgetId,
      generation: runtime.config.generation,
      token: runtime.config.token,
      pid: process.pid,
    }), true)
  })
  socket.on('data', chunk => {
    try {
      for (const frame of decoder.push(chunk)) {
        if (!sameRuntime(runtime, frame)) throw new Error('Companion runtime identity mismatch')
        if (frame.type === 'welcome') {
          if (runtime.authenticated) throw new Error('Duplicate companion welcome')
          if (frame.replayFrom > runtime.nextSeq) throw new Error('Invalid companion replay position')
          runtime.authenticated = true
          runtime.reconnectAttempt = 0
          const first = runtime.replay[0]?.seq ?? runtime.nextSeq
          const replayGap = frame.replayFrom < first
          for (const entry of runtime.replay) if (entry.seq >= frame.replayFrom) write(runtime, entry.encoded)
          // Report a gap after retained replay so sequence order stays monotonic.
          if (replayGap) {
            const snapshots = [
              runtime.sessionSnapshot,
              runtime.catalogSnapshot,
              runtime.lifecycleSnapshot,
              runtime.queueSnapshot,
              runtime.statsSnapshot,
            ].filter(
              (event): event is CompanionEventPayload => event !== undefined,
            )
            emit(runtime, { type: 'runtime_error', code: 'replay_gap', message: `Replay starts at ${first}, host requested ${frame.replayFrom}` })
            for (const event of snapshots) emit(runtime, event)
            emit(runtime, { type: 'runtime_error', code: 'replay_reset_complete', message: 'Current managed runtime state restored after replay gap' })
          }
        } else if (frame.type === 'control') {
          if (!runtime.authenticated) throw new Error('Control received before companion welcome')
          void dispatch(runtime, frame)
        } else if (frame.type === 'ping') {
          if (!runtime.authenticated) throw new Error('Ping received before companion welcome')
          write(runtime, encodePiCompanionFrame({ ...frame, type: 'pong' }))
        }
      }
    } catch (error) {
      socket.destroy(error instanceof Error ? error : new Error(String(error)))
    }
  })
  socket.on('close', () => {
    if (runtime.socket === socket) {
      runtime.socket = undefined
      runtime.decoder = undefined
      runtime.authenticated = false
      scheduleReconnect(runtime)
    }
  })
  // Errors are reflected by close; native TUI operation remains independent.
  socket.on('error', () => {})
}

function retain(runtime: ProcessRuntime, entry: ReplayEntry): void {
  runtime.replay.push(entry)
  runtime.replayBytes += entry.bytes
  while (
    runtime.replay.length > PI_COMPANION_MAX_REPLAY_EVENTS
    || runtime.replayBytes > PI_COMPANION_MAX_REPLAY_BYTES
  ) {
    runtime.replayBytes -= runtime.replay.shift()!.bytes
  }
}

function emit(runtime: ProcessRuntime, event: CompanionEventPayload): void {
  const seq = runtime.nextSeq++
  const frame = (payload: CompanionEventPayload) => ({
    v: 1 as const, type: 'event' as const, widgetId: runtime.config.widgetId,
    generation: runtime.config.generation, seq, event: payload,
  })
  let payload = event
  let encoded: string
  try {
    encoded = encodePiCompanionFrame(frame(payload))
  } catch (error) {
    // Observability must never break the native Pi run. Preserve event identity
    // while dropping unbounded provider/tool payloads; fall back to a small
    // runtime error for any other serialization/validation failure.
    if (event.type === 'tool') {
      payload = { ...event, input: undefined, output: undefined, truncated: true }
    } else if (event.type === 'assistant') {
      payload = { ...event, text: event.text ? truncateUtf8(event.text, 32_768) : event.text, truncated: true }
    } else {
      payload = {
        type: 'runtime_error', code: 'event_encoding_failed',
        message: error instanceof Error ? error.message.slice(0, 1024) : 'Unknown event encoding failure',
      }
    }
    try { encoded = encodePiCompanionFrame(frame(payload)) } catch { return }
  }
  if (payload.type === 'session') runtime.sessionSnapshot = payload
  if (payload.type === 'catalog') runtime.catalogSnapshot = payload
  if (payload.type === 'queue') runtime.queueSnapshot = payload
  if (payload.type === 'stats') runtime.statsSnapshot = payload
  if (payload.type === 'lifecycle' && (payload.phase === 'agent_start' || payload.phase === 'agent_settled')) {
    runtime.lifecycleSnapshot = payload
  }
  retain(runtime, { seq, encoded, bytes: bytes(encoded) })
  write(runtime, encoded)
}

function detach(runtime: ProcessRuntime, owner: number, quit: boolean): void {
  if (runtime.owner !== owner) return
  runtime.controlHandler = undefined
  // The authenticated transport belongs to the Pi process, not an individual
  // extension instance. Session replacement recreates extensions in-process;
  // retaining this socket avoids a close/reload race while releasing the old
  // instance's control context. Quit flushes the final shutdown frame.
  if (quit) {
    runtime.stopping = true
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer)
    runtime.reconnectTimer = undefined
    runtime.authenticated = false
    runtime.socket?.end()
    runtime.socket?.unref()
  }
}

function sessionEvent(ctx: ExtensionContext, phase: 'start' | 'info' | 'shutdown', reason?: string): CompanionEventPayload {
  const model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined
  return {
    type: 'session', phase, reason,
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    leafId: ctx.sessionManager.getLeafId() ?? undefined,
    name: ctx.sessionManager.getSessionName(),
    model,
    thinkingLevel: ctx.thinkingLevel,
  }
}

const usageNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

/**
 * Mirror Pi 0.84 AgentSession.getSessionStats() accounting. Extensions can read
 * the same entries/context state, but getSessionStats() itself is not exposed.
 */
function statsEvent(ctx: ExtensionContext): CompanionEventPayload {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  let assistantMessages = 0
  let toolCalls = 0
  const add = (usage: unknown) => {
    if (!usage || typeof usage !== 'object') return
    const value = usage as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; cost?: { total?: unknown } }
    totals.input += usageNumber(value.input)
    totals.output += usageNumber(value.output)
    totals.cacheRead += usageNumber(value.cacheRead)
    totals.cacheWrite += usageNumber(value.cacheWrite)
    totals.cost += usageNumber(value.cost?.total)
  }
  const manager = ctx.sessionManager as { getEntries?: () => unknown[] }
  const entries = typeof manager.getEntries === 'function' ? manager.getEntries() : []
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as { type?: string; usage?: unknown; message?: { role?: string; usage?: unknown; content?: unknown } }
    if ((entry.type === 'branch_summary' || entry.type === 'compaction') && entry.usage) add(entry.usage)
    if (entry.type !== 'message' || !entry.message) continue
    if (entry.message.role === 'toolResult' && entry.message.usage) add(entry.message.usage)
    if (entry.message.role === 'assistant') {
      assistantMessages += 1
      if (Array.isArray(entry.message.content)) {
        toolCalls += entry.message.content.filter(block => (block as { type?: string })?.type === 'toolCall').length
      }
      add(entry.message.usage)
    }
  }
  const usage = typeof ctx.getContextUsage === 'function' ? ctx.getContextUsage() : undefined
  const context = usage && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0
    ? {
        tokens: typeof usage.tokens === 'number' && Number.isFinite(usage.tokens) && usage.tokens >= 0 ? usage.tokens : null,
        window: usage.contextWindow,
        percent: typeof usage.percent === 'number' && Number.isFinite(usage.percent) && usage.percent >= 0 ? usage.percent : null,
      }
    : undefined
  const sessionId = ctx.sessionManager.getSessionId?.()
  return {
    type: 'stats',
    ...(sessionId ? { sessionId: truncateUtf8(sessionId, 512) } : {}),
    tokens: {
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      total: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
    },
    costUsd: totals.cost,
    assistantMessages,
    toolCalls,
    ...(context ? { context } : {}),
  }
}

function queueEvent(ctx: ExtensionContext): CompanionEventPayload {
  return { type: 'queue', pending: ctx.hasPendingMessages() }
}

function catalogEvent(pi: ExtensionAPI, ctx: ExtensionContext): CompanionEventPayload {
  const seenModels = new Set<string>()
  const models = ctx.scopedModels.flatMap(({ model }) => {
    const key = `${model.provider}\u0000${model.id}`
    if (seenModels.has(key)) return []
    seenModels.add(key)
    return [{
      provider: truncateUtf8(model.provider, 256),
      id: truncateUtf8(model.id, 1024),
      ...(model.name ? { name: truncateUtf8(model.name, 1024) } : {}),
    }]
  }).slice(0, 64)
  const active = new Set(pi.getActiveTools())
  const seenTools = new Set<string>()
  const tools = pi.getAllTools().flatMap(tool => {
    if (seenTools.has(tool.name)) return []
    seenTools.add(tool.name)
    return [{
      name: truncateUtf8(tool.name, 256),
      ...(tool.description ? { description: truncateUtf8(tool.description, 512) } : {}),
      active: active.has(tool.name),
    }]
  }).slice(0, 128)
  return {
    type: 'catalog',
    models,
    thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    tools,
  }
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g

/** Mirror Pi 0.84 built-in file-tool path resolution without importing private APIs. */
function resolvedToolPath(toolName: string, input: unknown, cwd: string): string | undefined {
  if (!['read', 'write', 'edit'].includes(toolName)) return undefined
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const raw = (input as { path?: unknown }).path
  if (typeof raw !== 'string' || !raw || /[\u0000\r\n]/.test(raw)) return undefined
  try {
    let normalized = raw.replace(UNICODE_SPACES, ' ')
    if (normalized.startsWith('@')) normalized = normalized.slice(1)
    if (normalized === '~') normalized = homedir()
    else if (normalized.startsWith('~/')) normalized = join(homedir(), normalized.slice(2))
    else if (/^file:\/\//.test(normalized)) normalized = fileURLToPath(normalized)
    const absolute = isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized)
    return bytes(absolute) <= 32 * 1024 ? absolute : undefined
  } catch {
    return undefined
  }
}

function assistantMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap(block => {
      if (!block || typeof block !== 'object') return []
      const value = block as { type?: string; text?: unknown }
      return value.type === 'text' && typeof value.text === 'string' ? [value.text] : []
    })
    .join('\n')
}

function setFinalAssistantText(runtime: ProcessRuntime, value: string): void {
  const bounded = truncateUtf8Tail(value, 64 * 1024)
  runtime.currentAssistantText = bounded
  runtime.assistantTextTruncated = bounded !== value
}

function outcome(messages: unknown[]): 'completed' | 'aborted' | 'failed' | 'unknown' {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; stopReason?: string }
    if (message?.role !== 'assistant') continue
    if (message.stopReason === 'aborted') return 'aborted'
    if (message.stopReason === 'error') return 'failed'
    return 'completed'
  }
  return 'unknown'
}

export default function companion(pi: ExtensionAPI): void {
  const runtime = state()
  if (!runtime) return
  const owner = ++runtime.owner
  let ctx: ExtensionContext | undefined
  let settledOutcome: 'completed' | 'aborted' | 'failed' | 'unknown' = 'unknown'
  runtime.controlHandler = async frame => {
    switch (frame.control.type) {
      case 'prompt':
        pi.sendUserMessage(frame.control.text, frame.control.deliverAs ? { deliverAs: frame.control.deliverAs } : undefined)
        if (ctx) emit(runtime, queueEvent(ctx))
        return
      case 'rename':
        pi.setSessionName(frame.control.name)
        return
      case 'configure': {
        if (!ctx) throw new Error('Pi extension context is not ready')
        if (!ctx.isIdle()) throw new Error('Pi settings can only change while the agent is idle')
        const selectedModel = frame.control.model
          ? ctx.scopedModels.find(({ model }) => (
              model.provider === frame.control.model!.provider && model.id === frame.control.model!.id
            ))?.model
          : undefined
        if (frame.control.model && !selectedModel) throw new Error('Requested model is not available in this Pi session')
        const availableTools = new Set(pi.getAllTools().map(tool => tool.name))
        if (frame.control.activeTools) {
          const unknown = frame.control.activeTools.find(tool => !availableTools.has(tool))
          if (unknown) throw new Error(`Requested tool is not available: ${unknown}`)
        }
        if (frame.control.tool && !availableTools.has(frame.control.tool.name)) {
          throw new Error(`Requested tool is not available: ${frame.control.tool.name}`)
        }
        if (selectedModel && !(await pi.setModel(selectedModel))) {
          throw new Error('Requested model is unavailable or has no credentials')
        }
        if (frame.control.thinkingLevel) pi.setThinkingLevel(frame.control.thinkingLevel)
        if (frame.control.activeTools) pi.setActiveTools(frame.control.activeTools)
        if (frame.control.tool) {
          const activeTools = new Set(pi.getActiveTools())
          if (frame.control.tool.active) activeTools.add(frame.control.tool.name)
          else activeTools.delete(frame.control.tool.name)
          pi.setActiveTools([...activeTools])
        }
        emit(runtime, sessionEvent(ctx, 'info'))
        emit(runtime, catalogEvent(pi, ctx))
        return
      }
      case 'abort':
        if (!ctx) throw new Error('Pi extension context is not ready')
        ctx.abort()
        return
      case 'shutdown':
        if (!ctx) throw new Error('Pi extension context is not ready')
        ctx.shutdown()
        return
    }
  }
  connect(runtime)

  const remember = (next: ExtensionContext) => { ctx = next }
  pi.on('session_start', (event, next) => {
    remember(next)
    emit(runtime, sessionEvent(next, 'start', event.reason))
    emit(runtime, catalogEvent(pi, next))
    emit(runtime, queueEvent(next))
    emit(runtime, statsEvent(next))
  })
  pi.on('session_info_changed', (_event, next) => {
    remember(next)
    emit(runtime, sessionEvent(next, 'info'))
  })
  pi.on('session_tree', (_event, next) => {
    remember(next)
    emit(runtime, sessionEvent(next, 'info'))
    emit(runtime, statsEvent(next))
  })
  pi.on('session_compact', (_event, next) => {
    remember(next)
    emit(runtime, sessionEvent(next, 'info'))
    emit(runtime, statsEvent(next))
  })
  pi.on('model_select', (_event, next) => {
    remember(next)
    emit(runtime, sessionEvent(next, 'info'))
    emit(runtime, catalogEvent(pi, next))
    emit(runtime, statsEvent(next))
  })
  pi.on('thinking_level_select', (_event, next) => {
    remember(next)
    emit(runtime, sessionEvent(next, 'info'))
    emit(runtime, catalogEvent(pi, next))
  })
  pi.on('before_agent_start', (_event, next) => {
    remember(next)
    settledOutcome = 'unknown'
    runtime.currentRunId = `${runtime.config.generation}:${++runtime.nextRun}`
    runtime.currentAssistantText = ''
    runtime.assistantTextTruncated = false
  })
  pi.on('agent_start', (_event, next) => {
    remember(next)
    emit(runtime, {
      type: 'lifecycle', phase: 'agent_start',
      ...(runtime.currentRunId ? { runId: runtime.currentRunId } : {}),
    })
    emit(runtime, queueEvent(next))
  })
  pi.on('agent_end', (event, next) => {
    remember(next)
    const finalOutcome = outcome(event.messages)
    if (finalOutcome !== 'unknown' || settledOutcome === 'unknown') settledOutcome = finalOutcome
    emit(runtime, {
      type: 'lifecycle', phase: 'agent_end', outcome: settledOutcome,
      ...(runtime.currentRunId ? { runId: runtime.currentRunId } : {}),
    })
  })
  pi.on('agent_settled', (_event, next) => {
    remember(next)
    emit(runtime, {
      type: 'lifecycle', phase: 'agent_settled',
      outcome: settledOutcome === 'unknown' ? 'completed' : settledOutcome,
      ...(runtime.currentRunId ? { runId: runtime.currentRunId } : {}),
      ...(runtime.currentAssistantText ? { assistantText: runtime.currentAssistantText } : {}),
      ...(runtime.assistantTextTruncated ? { truncated: true } : {}),
    })
    emit(runtime, sessionEvent(next, 'info'))
    emit(runtime, catalogEvent(pi, next))
    emit(runtime, queueEvent(next))
    emit(runtime, statsEvent(next))
  })
  pi.on('turn_start', (event, next) => {
    remember(next)
    emit(runtime, { type: 'lifecycle', phase: 'turn_start', turnIndex: event.turnIndex })
  })
  pi.on('turn_end', (event, next) => {
    remember(next)
    emit(runtime, { type: 'lifecycle', phase: 'turn_end', turnIndex: event.turnIndex })
    emit(runtime, statsEvent(next))
  })
  pi.on('message_update', (event, next) => {
    remember(next)
    const update = event.assistantMessageEvent
    if (update.type === 'start') {
      runtime.currentAssistantText = ''
      runtime.assistantTextTruncated = false
    }
    if (update.type === 'text_start') emit(runtime, { type: 'assistant', phase: 'start' })
    if (update.type === 'text_delta') {
      const combined = runtime.currentAssistantText + update.delta
      const bounded = truncateUtf8Tail(combined, 64 * 1024)
      if (bounded !== combined) runtime.assistantTextTruncated = true
      runtime.currentAssistantText = bounded
      emit(runtime, { type: 'assistant', phase: 'delta', text: update.delta })
    }
    if (update.type === 'text_end') emit(runtime, { type: 'assistant', phase: 'end' })
    if (update.type === 'done') setFinalAssistantText(runtime, assistantMessageText(update.message))
    if (update.type === 'error') {
      setFinalAssistantText(runtime, assistantMessageText(update.error))
      settledOutcome = update.reason === 'aborted' ? 'aborted' : 'failed'
    }
  })
  pi.on('tool_execution_start', (event, next) => {
    remember(next)
    const resolvedPath = resolvedToolPath(event.toolName, event.args, next.cwd)
    emit(runtime, {
      type: 'tool', phase: 'start', callId: event.toolCallId, name: event.toolName, input: event.args,
      ...(resolvedPath ? { resolvedPath } : {}),
    })
  })
  pi.on('tool_execution_update', (event, next) => {
    remember(next)
    emit(runtime, { type: 'tool', phase: 'update', callId: event.toolCallId, name: event.toolName, output: event.partialResult })
  })
  pi.on('tool_execution_end', (event, next) => {
    remember(next)
    emit(runtime, { type: 'tool', phase: 'end', callId: event.toolCallId, name: event.toolName, output: event.result, isError: event.isError })
  })
  pi.on('session_shutdown', (event, next) => {
    remember(next)
    emit(runtime, sessionEvent(next, 'shutdown', event.reason))
    detach(runtime, owner, event.reason === 'quit')
  })
}
