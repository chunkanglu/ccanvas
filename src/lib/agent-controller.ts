import type { AgentHarness, AgentThinkingLevel, WidgetElement } from './types'

/** Stable canvas identity plus one concrete process incarnation. */
export type AgentRuntimeKey = {
  widgetId: string
  generation: number
}

/** Harness-owned durable identity. Neither field is a widget/process identity. */
export type AgentSessionIdentity = {
  sessionId?: string
  sessionFile?: string
}

export type AgentLaunchSpec = AgentRuntimeKey & {
  harness: AgentHarness
  cwd: string
  session: AgentSessionIdentity
  provider?: string
  model?: string
  thinkingLevel?: AgentThinkingLevel
  toolProfile?: string
  initialPrompt?: string
}

export type AgentCapability =
  | 'prompt'
  | 'steer'
  | 'follow-up'
  | 'abort'
  | 'rename'
  | 'session-resume'
  | 'native-ui'
  | 'structured-tools'

export type AgentLifecycle =
  | 'disconnected'
  | 'starting'
  | 'idle'
  | 'working'
  | 'waiting'
  | 'stopping'
  | 'failed'

export type AgentOutcome = 'completed' | 'aborted' | 'failed'

export type AgentRuntimeEvent = AgentRuntimeKey & { seq: number } & (
  | { type: 'capabilities'; capabilities: AgentCapability[] }
  | { type: 'session'; session: AgentSessionIdentity }
  | { type: 'lifecycle'; state: AgentLifecycle; detail?: string }
  | { type: 'assistant-text'; text: string; delta: boolean }
  | { type: 'tool'; callId: string; phase: 'start' | 'update' | 'end'; name: string; input?: unknown; output?: unknown; error?: string }
  | { type: 'ui-request'; requestId: string; method: string; payload: unknown }
  | { type: 'settled'; runId: string; outcome: AgentOutcome; text?: string; truncated?: boolean; error?: string }
)

export type AgentControl =
  | { type: 'prompt' | 'steer' | 'follow-up'; requestId: string; text: string }
  | { type: 'abort'; requestId: string }
  | { type: 'rename'; requestId: string; name: string }
  | { type: 'ui-response'; requestId: string; value: unknown }

export type AgentRuntimeHandle = {
  readonly key: AgentRuntimeKey
  readonly harness: AgentHarness
  send(control: AgentControl): Promise<void>
  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void
  detach(): void
  kill(): Promise<void>
}

/** Transport-specific controllers implement this contract in phase 2. */
export interface AgentController {
  readonly harness: AgentHarness
  connect(spec: AgentLaunchSpec): Promise<AgentRuntimeHandle>
}

/**
 * Convert portable widget configuration into an explicit runtime request.
 * Local trust/auth/credential state is deliberately absent and remains Pi-owned.
 */
export function launchSpecFor(
  agent: WidgetElement,
  generation: number,
  workspaceDir?: string,
): AgentLaunchSpec {
  if (agent.kind !== 'agent') throw new Error('Agent launch requires an agent widget')
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('Agent process generation must be a positive safe integer')
  }
  const harness: AgentHarness = agent.harness === 'pi' ? 'pi' : 'claude'
  return {
    widgetId: agent.id,
    generation,
    harness,
    cwd: agent.cwd || workspaceDir || '~',
    session: { sessionId: agent.sessionId, sessionFile: agent.sessionFile },
    provider: agent.provider,
    model: agent.model,
    thinkingLevel: agent.thinkingLevel,
    toolProfile: agent.toolProfile,
    initialPrompt: agent.agentPrompt,
  }
}

/**
 * Reject delayed events from a replaced process. Sequence numbers are scoped to
 * one generation; they are ordering evidence, not exactly-once delivery proof.
 */
export class AgentEventGate {
  private readonly active = new Map<string, { generation: number; seq: number; attached: boolean }>()

  attach(key: AgentRuntimeKey): void {
    if (!Number.isSafeInteger(key.generation) || key.generation < 1) {
      throw new Error('Agent process generation must be a positive safe integer')
    }
    const current = this.active.get(key.widgetId)
    if (current && key.generation <= current.generation) {
      throw new Error('Agent process generations must increase monotonically')
    }
    this.active.set(key.widgetId, { generation: key.generation, seq: -1, attached: true })
  }

  accept(event: AgentRuntimeEvent): boolean {
    const current = this.active.get(event.widgetId)
    if (
      !current?.attached
      || current.generation !== event.generation
      || !Number.isSafeInteger(event.seq)
      || event.seq < 0
      || event.seq <= current.seq
    ) return false
    current.seq = event.seq
    return true
  }

  detach(key: AgentRuntimeKey): boolean {
    const current = this.active.get(key.widgetId)
    if (!current?.attached || current.generation !== key.generation) return false
    current.attached = false
    return true
  }
}
