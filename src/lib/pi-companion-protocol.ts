export const PI_COMPANION_VERSION = 1 as const
export const PI_COMPANION_MAX_FRAME_BYTES = 256 * 1024
export const PI_COMPANION_MAX_REPLAY_EVENTS = 512
export const PI_COMPANION_MAX_REPLAY_BYTES = 4 * 1024 * 1024

export type RuntimeIdentity = {
  widgetId: string
  generation: number
}

export type CompanionHello = RuntimeIdentity & {
  v: typeof PI_COMPANION_VERSION
  type: 'hello'
  token: string
  pid: number
}

export type CompanionWelcome = RuntimeIdentity & {
  v: typeof PI_COMPANION_VERSION
  type: 'welcome'
  replayFrom: number
}

export type CompanionEventPayload =
  | {
      type: 'session'
      phase: 'start' | 'info' | 'shutdown'
      reason?: string
      sessionId?: string
      sessionFile?: string
      name?: string
      model?: { provider: string; id: string }
      thinkingLevel?: string
    }
  | {
      type: 'lifecycle'
      phase: 'agent_start' | 'agent_end' | 'agent_settled' | 'turn_start' | 'turn_end'
      turnIndex?: number
      outcome?: 'completed' | 'aborted' | 'failed' | 'unknown'
    }
  | { type: 'assistant'; phase: 'start' | 'delta' | 'end'; text?: string; truncated?: boolean }
  | {
      type: 'tool'
      phase: 'start' | 'update' | 'end'
      callId: string
      name: string
      input?: unknown
      output?: unknown
      isError?: boolean
      truncated?: boolean
    }
  | { type: 'runtime_error'; code: string; message: string }

export type CompanionEvent = RuntimeIdentity & {
  v: typeof PI_COMPANION_VERSION
  type: 'event'
  seq: number
  event: CompanionEventPayload
}

export type CompanionControlPayload =
  | { type: 'prompt'; text: string; deliverAs?: 'steer' | 'followUp' }
  | { type: 'abort' }
  | { type: 'rename'; name: string }
  | { type: 'shutdown' }

export type CompanionControl = RuntimeIdentity & {
  v: typeof PI_COMPANION_VERSION
  type: 'control'
  requestId: string
  control: CompanionControlPayload
}

export type CompanionResult = RuntimeIdentity & {
  v: typeof PI_COMPANION_VERSION
  type: 'result'
  requestId: string
  ok: boolean
  error?: string
}

export type CompanionPing = RuntimeIdentity & {
  v: typeof PI_COMPANION_VERSION
  type: 'ping'
  nonce: string
}

export type CompanionPong = RuntimeIdentity & {
  v: typeof PI_COMPANION_VERSION
  type: 'pong'
  nonce: string
}

export type PiCompanionFrame =
  | CompanionHello
  | CompanionWelcome
  | CompanionEvent
  | CompanionControl
  | CompanionResult
  | CompanionPing
  | CompanionPong

export type HostInboundFrame = CompanionHello | CompanionEvent | CompanionResult | CompanionPong
export type CompanionInboundFrame = CompanionWelcome | CompanionControl | CompanionPing

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max = 8192): value is string =>
  typeof value === 'string'
  && value.length > 0
  && byteLength(value) <= max
  && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)
const integer = (value: unknown, min = 0): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min

function assertRuntime(value: Record<string, unknown>): void {
  if (!text(value.widgetId, 256)) throw new Error('Invalid companion widget id')
  if (!integer(value.generation, 1)) throw new Error('Invalid companion generation')
}

function assertEvent(value: unknown): asserts value is CompanionEventPayload {
  if (!object(value) || !text(value.type, 32)) throw new Error('Invalid companion event')
  switch (value.type) {
    case 'session':
      if (!['start', 'info', 'shutdown'].includes(String(value.phase))) throw new Error('Invalid session event')
      for (const key of ['reason', 'sessionId', 'name', 'thinkingLevel']) {
        if (value[key] !== undefined && !text(value[key], 1024)) throw new Error(`Invalid session ${key}`)
      }
      if (value.sessionFile !== undefined && !text(value.sessionFile, 8192)) throw new Error('Invalid session file')
      if (value.model !== undefined && (!object(value.model) || !text(value.model.provider, 256) || !text(value.model.id, 1024))) {
        throw new Error('Invalid session model')
      }
      return
    case 'lifecycle':
      if (!['agent_start', 'agent_end', 'agent_settled', 'turn_start', 'turn_end'].includes(String(value.phase))) {
        throw new Error('Invalid lifecycle event')
      }
      if (value.turnIndex !== undefined && !integer(value.turnIndex)) throw new Error('Invalid turn index')
      if (value.outcome !== undefined && !['completed', 'aborted', 'failed', 'unknown'].includes(String(value.outcome))) {
        throw new Error('Invalid lifecycle outcome')
      }
      return
    case 'assistant':
      if (!['start', 'delta', 'end'].includes(String(value.phase))) throw new Error('Invalid assistant event')
      if (value.text !== undefined && typeof value.text !== 'string') throw new Error('Invalid assistant text')
      if (value.truncated !== undefined && typeof value.truncated !== 'boolean') throw new Error('Invalid assistant truncation state')
      return
    case 'tool':
      if (!['start', 'update', 'end'].includes(String(value.phase)) || !text(value.callId, 512) || !text(value.name, 512)) {
        throw new Error('Invalid tool event')
      }
      if (value.isError !== undefined && typeof value.isError !== 'boolean') throw new Error('Invalid tool error state')
      if (value.truncated !== undefined && typeof value.truncated !== 'boolean') throw new Error('Invalid tool truncation state')
      return
    case 'runtime_error':
      if (!text(value.code, 256) || !text(value.message, 8192)) throw new Error('Invalid runtime error')
      return
    default:
      throw new Error('Unknown companion event')
  }
}

function assertControl(value: unknown): asserts value is CompanionControlPayload {
  if (!object(value) || !text(value.type, 32)) throw new Error('Invalid companion control')
  switch (value.type) {
    case 'prompt':
      if (!text(value.text, PI_COMPANION_MAX_FRAME_BYTES) || (value.deliverAs !== undefined && !['steer', 'followUp'].includes(String(value.deliverAs)))) {
        throw new Error('Invalid prompt control')
      }
      return
    case 'rename':
      if (!text(value.name, 1024)) throw new Error('Invalid rename control')
      return
    case 'abort':
    case 'shutdown':
      return
    default:
      throw new Error('Unknown companion control')
  }
}

export function decodePiCompanionFrame(line: string): PiCompanionFrame {
  if (!line || byteLength(line) > PI_COMPANION_MAX_FRAME_BYTES) throw new Error('Companion frame exceeds bounds')
  let value: unknown
  try { value = JSON.parse(line) } catch { throw new Error('Invalid companion JSON') }
  if (!object(value) || value.v !== PI_COMPANION_VERSION || !text(value.type, 32)) {
    throw new Error('Invalid companion envelope')
  }
  assertRuntime(value)
  if (value.type !== 'hello' && Object.prototype.hasOwnProperty.call(value, 'token')) {
    throw new Error('Capability token is only valid in the hello frame')
  }
  switch (value.type) {
    case 'hello':
      if (!text(value.token, 512) || !/^[A-Za-z0-9_-]{43,512}$/.test(value.token) || !integer(value.pid, 1)) {
        throw new Error('Invalid companion hello')
      }
      break
    case 'welcome':
      if (!integer(value.replayFrom)) throw new Error('Invalid companion welcome')
      break
    case 'event':
      if (!integer(value.seq)) throw new Error('Invalid companion sequence')
      assertEvent(value.event)
      break
    case 'control':
      if (!text(value.requestId, 256)) throw new Error('Invalid companion request id')
      assertControl(value.control)
      break
    case 'result':
      if (!text(value.requestId, 256) || typeof value.ok !== 'boolean' || (value.error !== undefined && !text(value.error, 8192))) {
        throw new Error('Invalid companion result')
      }
      break
    case 'ping':
    case 'pong':
      if (!text(value.nonce, 256)) throw new Error('Invalid companion ping')
      break
    default:
      throw new Error('Unknown companion frame')
  }
  return value as PiCompanionFrame
}

export function decodeHostInboundFrame(line: string): HostInboundFrame {
  const frame = decodePiCompanionFrame(line)
  if (!['hello', 'event', 'result', 'pong'].includes(frame.type)) throw new Error('Frame is not valid companion-to-host traffic')
  return frame as HostInboundFrame
}

export function decodeCompanionInboundFrame(line: string): CompanionInboundFrame {
  const frame = decodePiCompanionFrame(line)
  if (!['welcome', 'control', 'ping'].includes(frame.type)) throw new Error('Frame is not valid host-to-companion traffic')
  return frame as CompanionInboundFrame
}

export function encodePiCompanionFrame(frame: PiCompanionFrame): string {
  const encoded = JSON.stringify(frame)
  // Validate output too: callers cannot bypass bounds with a type assertion.
  decodePiCompanionFrame(encoded)
  if (byteLength(encoded) + 1 > PI_COMPANION_MAX_FRAME_BYTES) throw new Error('Companion frame exceeds bounds')
  return `${encoded}\n`
}

/** Incremental strict JSONL framing for arbitrary TCP chunk boundaries. */
export class PiCompanionFrameDecoder<T extends PiCompanionFrame = PiCompanionFrame> {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private buffer = ''

  constructor(private readonly decode: (line: string) => T = decodePiCompanionFrame as (line: string) => T) {}

  push(chunk: Uint8Array): T[] {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    if (byteLength(this.buffer) > PI_COMPANION_MAX_FRAME_BYTES && !this.buffer.includes('\n')) {
      throw new Error('Unterminated companion frame exceeds bounds')
    }
    const frames: T[] = []
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      let line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (!line) throw new Error('Empty companion frame')
      frames.push(this.decode(line))
    }
    if (byteLength(this.buffer) > PI_COMPANION_MAX_FRAME_BYTES) throw new Error('Companion frame exceeds bounds')
    return frames
  }

  finish(): T[] {
    this.buffer += this.decoder.decode()
    if (!this.buffer) return []
    throw new Error('Truncated companion frame')
  }
}
