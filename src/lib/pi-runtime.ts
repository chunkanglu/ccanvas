import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { AgentThinkingLevel } from './types'
import {
  decodeHostInboundFrame,
  type CompanionControlPayload,
  type CompanionEvent,
  type CompanionResult,
  type CompanionPong,
} from './pi-companion-protocol'

export type ManagedPiOpenOptions = {
  /** Backend process identity; includes the in-memory workspace instance. */
  id: string
  /** Portable canvas widget identity carried by companion frames. */
  widgetId: string
  cols: number
  rows: number
  cwd: string
  sessionFile?: string
  provider?: string
  model?: string
  thinkingLevel?: AgentThinkingLevel
}

export type ManagedPiStatus = {
  id: string
  generation: number
  connected: boolean
  error?: string
}

export type ManagedPiEventDelivery = { replayed: boolean }

export type ManagedPiHandlers = {
  onData(data: Uint8Array): void
  onEvent(frame: CompanionEvent | CompanionResult | CompanionPong, delivery: ManagedPiEventDelivery): void
  onStatus(status: ManagedPiStatus): void
  onExit(): void
}

export type ManagedPiRuntime = {
  readonly generation: number
  readonly reused: boolean
  start(): void
  send(data: string): void
  resize(cols: number, rows: number): void
  control(control: CompanionControlPayload, requestId?: string): Promise<string>
  close(): void
  kill(): void
}

type OpenResult = {
  reattached: boolean
  generation: number
  companionConnected: boolean
}

type Event<T> = { payload: T }
type Bridge = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
  listen<T>(event: string, handler: (event: Event<T>) => void): Promise<UnlistenFn>
}

export type ManagedPiDelivery = 'steer' | 'followUp'

export function managedPiPromptControl(
  text: string,
  activeRun: boolean,
  delivery: ManagedPiDelivery = 'followUp',
): CompanionControlPayload {
  return { type: 'prompt', text, ...(activeRun ? { deliverAs: delivery } : {}) }
}

const nativeBridge: Bridge = { invoke, listen }
const activeGenerations = new Map<string, number>()
let lastIntentEpoch = 0
const nextIntentEpoch = () => {
  lastIntentEpoch = Math.max(Date.now() * 1000, lastIntentEpoch + 1)
  return lastIntentEpoch
}
const pendingOpens = new Map<string, Map<symbol, boolean>>()

function beginOpen(id: string): symbol {
  const token = Symbol(id)
  const opens = pendingOpens.get(id) ?? new Map<symbol, boolean>()
  opens.set(token, false)
  pendingOpens.set(id, opens)
  return token
}

function finishOpen(id: string, token: symbol): boolean {
  const opens = pendingOpens.get(id)
  const killRequested = opens?.get(token) === true
  opens?.delete(token)
  if (opens?.size === 0) pendingOpens.delete(id)
  return killRequested
}

/** Permanently stop a managed Pi runtime when its widget is deleted. */
export function killManagedPi(id: string, bridge: Bridge = nativeBridge): void {
  const opens = pendingOpens.get(id)
  if (opens) for (const token of opens.keys()) opens.set(token, true)
  activeGenerations.delete(id)
  // A restored hidden tab may never have opened in this webview, so its
  // generation is unknown here even though the backend still owns a process.
  void bridge.invoke('pi_kill_current', { id, deleteEpoch: nextIntentEpoch() }).catch(() => {})
}

/**
 * Attach to a backend-owned native Pi runtime. Listeners are installed before
 * spawn/reattach, and every callback is filtered by backend process generation.
 */
export async function connectManagedPi(
  options: ManagedPiOpenOptions,
  handlers: ManagedPiHandlers,
  bridge: Bridge = nativeBridge,
): Promise<ManagedPiRuntime> {
  const attachmentId = crypto.randomUUID()
  const openEpoch = nextIntentEpoch()
  let generation: number | undefined
  let closed = false
  let started = false
  let opening = true
  const openToken = beginOpen(options.id)
  const pending: Array<() => void> = []
  const pendingControls = new Map<string, {
    resolve: (requestId: string) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  const unlisten: UnlistenFn[] = []

  const rejectPendingControls = (message: string) => {
    for (const [requestId, pendingControl] of pendingControls) {
      clearTimeout(pendingControl.timer)
      pendingControl.reject(new Error(`${message} (${requestId})`))
    }
    pendingControls.clear()
  }

  const whenCurrent = (candidate: number, action: () => void) => {
    if (closed) return
    if (generation === undefined) pending.push(() => {
      if (candidate === generation) action()
    })
    else if (candidate === generation) action()
  }

  try {
    const registrations = [
      bridge.listen<{ id: string; generation: number; bytes: number[] }>('pi:pty-data', event => {
        if (event.payload.id !== options.id) return
        whenCurrent(event.payload.generation, () => handlers.onData(new Uint8Array(event.payload.bytes)))
      }),
      bridge.listen<{ id: string; generation: number }>('pi:exit', event => {
        if (event.payload.id !== options.id) return
        whenCurrent(event.payload.generation, () => {
          if (activeGenerations.get(options.id) === event.payload.generation) {
            activeGenerations.delete(options.id)
          }
          rejectPendingControls('Managed Pi process exited before control acknowledgement')
          handlers.onExit()
        })
      }),
      bridge.listen<{ id: string; generation: number; replayed: boolean; frame: Record<string, unknown> }>('pi:companion', event => {
        if (event.payload.id !== options.id) return
        const candidate = Number(event.payload.generation)
        whenCurrent(candidate, () => {
          try {
            const frame = decodeHostInboundFrame(JSON.stringify(event.payload.frame))
            if (frame.widgetId !== options.widgetId || frame.generation !== candidate) {
              throw new Error('Managed Pi companion identity mismatch')
            }
            if (frame.type === 'result') {
              const pendingControl = pendingControls.get(frame.requestId)
              if (pendingControl) {
                clearTimeout(pendingControl.timer)
                pendingControls.delete(frame.requestId)
                if (frame.ok) pendingControl.resolve(frame.requestId)
                else pendingControl.reject(new Error(frame.error ?? 'Pi control failed'))
              }
            }
            if (frame.type === 'event' || frame.type === 'result' || frame.type === 'pong') {
              handlers.onEvent(frame, { replayed: event.payload.replayed === true })
            }
          } catch (error) {
            handlers.onStatus({
              id: options.id,
              generation: candidate,
              connected: false,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        })
      }),
      bridge.listen<ManagedPiStatus>('pi:companion-status', event => {
        if (event.payload.id !== options.id) return
        whenCurrent(event.payload.generation, () => handlers.onStatus(event.payload))
      }),
    ]
    const settled = await Promise.allSettled(registrations)
    for (const registration of settled) {
      if (registration.status === 'fulfilled') unlisten.push(registration.value)
    }
    const rejected = settled.find(
      (registration): registration is PromiseRejectedResult => registration.status === 'rejected',
    )
    if (rejected) throw rejected.reason

    const result = await bridge.invoke<OpenResult>('pi_open', {
      request: {
        id: options.id,
        widgetId: options.widgetId,
        attachmentId,
        openEpoch,
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        sessionFile: options.sessionFile ?? null,
        provider: options.provider ?? null,
        model: options.model ?? null,
        thinkingLevel: options.thinkingLevel ?? null,
      },
    })
    if (!Number.isSafeInteger(result.generation) || result.generation < 1) {
      throw new Error('Native Pi runtime returned an invalid generation')
    }
    generation = result.generation
    const deletedWhileOpening = finishOpen(options.id, openToken)
    opening = false
    if (deletedWhileOpening) {
      closed = true
      for (const off of unlisten.splice(0)) off()
      await bridge.invoke('pi_kill', { id: options.id, generation, attachmentId })
      throw new Error('Managed Pi runtime was deleted while opening')
    }
    activeGenerations.set(options.id, generation)
    handlers.onStatus({
      id: options.id,
      generation,
      connected: result.companionConnected,
    })
    // Events emitted during open are replayed after the snapshot status, so a
    // just-authenticated companion cannot be overwritten by stale `false`.
    for (const action of pending.splice(0)) action()

    const invokeCurrent = (command: string, args: Record<string, unknown> = {}) => {
      if (closed) return
      void bridge.invoke(command, { id: options.id, generation, attachmentId, ...args }).catch(error => {
        handlers.onStatus({
          id: options.id,
          generation: generation!,
          connected: false,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }

    return {
      generation,
      reused: result.reattached,
      start() {
        if (started || closed) return
        started = true
        invokeCurrent('pi_start')
      },
      send(data) { invokeCurrent('pi_write', { data }) },
      resize(cols, rows) { invokeCurrent('pi_resize', { cols, rows }) },
      control(control, requestId = crypto.randomUUID()) {
        if (closed) return Promise.reject(new Error('Managed Pi runtime is closed'))
        if (pendingControls.has(requestId)) {
          return Promise.reject(new Error(`Pi control request is already pending: ${requestId}`))
        }
        return new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingControls.delete(requestId)
            reject(new Error(`Pi control acknowledgement timed out: ${requestId}`))
          }, 10_000)
          pendingControls.set(requestId, { resolve, reject, timer })
          void bridge.invoke('pi_control', {
            id: options.id,
            generation,
            attachmentId,
            requestId,
            control,
          }).catch(error => {
            const pendingControl = pendingControls.get(requestId)
            if (!pendingControl) return
            clearTimeout(pendingControl.timer)
            pendingControls.delete(requestId)
            reject(error instanceof Error ? error : new Error(String(error)))
          })
        })
      },
      close() {
        if (closed) return
        closed = true
        rejectPendingControls('Managed Pi runtime closed before control acknowledgement')
        for (const off of unlisten.splice(0)) off()
        void bridge.invoke('pi_detach', { id: options.id, generation, attachmentId }).catch(() => {})
      },
      kill() {
        if (!closed) {
          closed = true
          rejectPendingControls('Managed Pi runtime killed before control acknowledgement')
          for (const off of unlisten.splice(0)) off()
        }
        if (activeGenerations.get(options.id) === generation) activeGenerations.delete(options.id)
        void bridge.invoke('pi_kill', { id: options.id, generation, attachmentId }).catch(() => {})
      },
    }
  } catch (error) {
    if (opening) finishOpen(options.id, openToken)
    closed = true
    rejectPendingControls('Managed Pi runtime failed before control acknowledgement')
    for (const off of unlisten) off()
    throw error
  }
}
