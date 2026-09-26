// Provider-neutral arrow orchestration. Pi contributes authoritative settled-run
// records through its companion; Claude's PTY adapter produces the same shape
// from its existing quiet-screen/transcript heuristic.

import type { AgentHarness, ArrowElement, CanvasElement, WidgetElement, Workspace } from './types'
import { useStore } from '../store/workspace'
import { agentRuntimeId, deliverPrompt, isLive, stripAnsi, notify, type AgentDeliveryResult } from './agents'
import { readTranscript, extractLastAssistant } from './transcript'

const SUCCESS_RE =
  /\b(success(ful(ly)?)?|succeeded|done|complete[d]?|passed|✓|✔|finished|lgtm|ready)\b/i
const FAILURE_RE =
  /\b(fail(ed|ure|s)?|errored?|exception|✗|✘|cannot|could ?n'?t|denied|aborted|rejected|blocked)\b/i
const OUTPUT_TOKEN = /\{\{\s*(output|out|result|prev|previous)\s*\}\}/gi

export type SettledRunOutcome = 'completed' | 'failed' | 'aborted'
export type SettledAgentRun = {
  sourceId: string
  workspaceId: string
  harness: AgentHarness
  generation: number
  runId: string
  outcome: SettledRunOutcome
  assistantText: string
  truncated?: boolean
}

export type FlowDeliveryState = AgentDeliveryResult['status'] | 'pending'

/** Remove Claude TUI chrome from its compatibility-adapter output. */
export function cleanAgentOutput(tail: string): string {
  const lines = stripAnsi(tail).split('\n')
  const kept: string[] = []
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (/[╭╮╰╯│─┌┐└┘├┤┬┴┼]/.test(line)) continue
    if (/^\s*[>❯]\s*$/.test(line)) continue
    if (/\?\s*for shortcuts/i.test(line)) continue
    if (/^\s*(esc to interrupt|ctrl\+[a-z]|shift\+|tab to|⏎)/i.test(line)) continue
    kept.push(line)
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(-6000)
}

async function readLastClaudeAssistant(source: WidgetElement): Promise<string | null> {
  const content = await readTranscript(source.cwd, source.sessionId)
  return content ? extractLastAssistant(content) : null
}

function safeRegex(src: string): RegExp | null {
  try {
    return new RegExp(src, 'i')
  } catch {
    return null
  }
}

/** Runtime failure is explicit; success/failure remain visibly heuristic text modes. */
export function evaluateCondition(
  arrow: ArrowElement,
  assistantText: string,
  outcome: SettledRunOutcome = 'completed',
): boolean {
  const flow = arrow.flow
  if (!flow || outcome === 'aborted') return false
  if (flow.when === 'runtime-error') return outcome === 'failed'
  if (outcome !== 'completed') return false
  const text = assistantText.slice(-6000)
  switch (flow.when) {
    case 'always':
      return true
    case 'match': {
      if (!flow.pattern) return false
      const re = safeRegex(flow.pattern)
      return re ? re.test(text) : false
    }
    case 'success': {
      const re = flow.pattern ? safeRegex(flow.pattern) : SUCCESS_RE
      return re ? re.test(text) : false
    }
    case 'failure': {
      const re = flow.pattern ? safeRegex(flow.pattern) : FAILURE_RE
      return re ? re.test(text) : false
    }
  }
}

function wantsOutput(edge: ArrowElement): boolean {
  const prompt = edge.flow?.prompt?.trim() ?? ''
  if (!prompt) return true
  OUTPUT_TOKEN.lastIndex = 0
  const result = OUTPUT_TOKEN.test(prompt)
  OUTPUT_TOKEN.lastIndex = 0
  return result
}

function edgeText(edge: ArrowElement, output: string): string {
  const prompt = edge.flow?.prompt?.trim() ?? ''
  if (!prompt) return output
  OUTPUT_TOKEN.lastIndex = 0
  if (!OUTPUT_TOKEN.test(prompt)) return prompt
  OUTPUT_TOKEN.lastIndex = 0
  return prompt.replace(OUTPUT_TOKEN, output)
}

function hash(value: string): string {
  let forward = 0x811c9dc5
  let reverse = 0x9e3779b9
  for (let index = 0; index < value.length; index++) {
    forward ^= value.charCodeAt(index)
    forward = Math.imul(forward, 0x01000193)
    reverse ^= value.charCodeAt(value.length - index - 1)
    reverse = Math.imul(reverse, 0x85ebca6b)
  }
  return `${(forward >>> 0).toString(36)}${(reverse >>> 0).toString(36)}`
}

/** Deterministic revision of executable graph fields, independent of z-order noise. */
export function flowGraphRevision(workspace: Workspace): string {
  const records = workspace.elements
    .filter((element): element is ArrowElement => element.type === 'arrow' && !!element.flow)
    .map(edge => ({
      id: edge.id,
      from: edge.from?.id ?? '',
      to: edge.to?.id ?? '',
      enabled: edge.flow?.enabled !== false,
      when: edge.flow?.when ?? '',
      pattern: edge.flow?.pattern ?? '',
      prompt: edge.flow?.prompt ?? '',
      join: edge.flow?.join ?? 'all',
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return hash(JSON.stringify(records))
}

function isAgent(element: CanvasElement | undefined): element is WidgetElement {
  return !!element && element.type === 'widget' && element.kind === 'agent'
}

function tabContaining(id: string): Workspace | null {
  for (const tab of useStore.getState().tabs) {
    if (tab.elements.some(element => element.id === id)) return tab
  }
  return null
}

function flowEdges(
  workspace: Workspace,
  options: { from?: string; to?: string } = {},
): ArrowElement[] {
  const byId = new Map(workspace.elements.map(element => [element.id, element]))
  return workspace.elements.filter((element): element is ArrowElement => {
    if (element.type !== 'arrow' || !element.flow || element.flow.enabled === false) return false
    if (!element.from || !element.to) return false
    if (options.from && element.from.id !== options.from) return false
    if (options.to && element.to.id !== options.to) return false
    return isAgent(byId.get(element.from.id)) && isAgent(byId.get(element.to.id))
  })
}

type Satisfaction = { output: string; sourceRunKey: string }
type JoinState = {
  revision: string
  epoch: number
  createdAt: number
  edges: Map<string, Satisfaction>
}

const runtimeFlowId = (workspaceId: string, elementId: string) => `${workspaceId}:${elementId}`
const seenRuns = new Map<string, true>()
const workspaceRevisions = new Map<string, string>()
const satisfied = new Map<string, JoinState>()
const targetEpochs = new Map<string, number>()
const deliveries = new Map<string, FlowDeliveryState>()
let flowStateEpoch = 0

const MAX_RUNTIME_RECORDS = 4096
const MAX_JOIN_AGE_MS = 10 * 60_000
const FIRE_WINDOW_MS = 60_000
const FIRE_LIMIT = 60
let fireTimes: number[] = []

function boundedSet<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_RUNTIME_RECORDS) map.delete(map.keys().next().value!)
}

function clearWorkspaceState(workspaceId: string) {
  const prefix = `${workspaceId}:`
  for (const key of satisfied.keys()) if (key.startsWith(prefix)) satisfied.delete(key)
  for (const key of targetEpochs.keys()) if (key.startsWith(prefix)) targetEpochs.delete(key)
}

function ensureGraphRevision(workspace: Workspace): string {
  const revision = flowGraphRevision(workspace)
  const previous = workspaceRevisions.get(workspace.id)
  if (previous !== undefined && previous !== revision) clearWorkspaceState(workspace.id)
  workspaceRevisions.set(workspace.id, revision)
  return revision
}

function stillArmed(workspaceId: string, revision: string, epoch: number): boolean {
  if (!useStore.getState().flowsEnabled || epoch !== flowStateEpoch) return false
  const workspace = useStore.getState().tabs.find(tab => tab.id === workspaceId)
  return !!workspace && flowGraphRevision(workspace) === revision
}

function allowFire(): boolean {
  const now = Date.now()
  fireTimes = fireTimes.filter(time => now - time < FIRE_WINDOW_MS)
  if (fireTimes.length >= FIRE_LIMIT) {
    useStore.getState().setFlowsEnabled(false)
    notify('ccanvas flows paused', 'Too many automatic runs in one minute.')
    return false
  }
  fireTimes.push(now)
  return true
}

/** Pause/re-arm and graph replacement discard every unconsumed runtime record. */
export function resetFlowState() {
  flowStateEpoch += 1
  seenRuns.clear()
  workspaceRevisions.clear()
  satisfied.clear()
  targetEpochs.clear()
  deliveries.clear()
  fireTimes = []
}

export function flowDeliveryState(deliveryId: string): FlowDeliveryState | undefined {
  return deliveries.get(deliveryId)
}

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

async function deliverFlow(
  workspace: Workspace,
  target: WidgetElement,
  prompt: string,
  deliveryId: string,
  revision: string,
  epoch: number,
): Promise<void> {
  if (deliveries.has(deliveryId) || !stillArmed(workspace.id, revision, epoch)) return
  const runtimeId = agentRuntimeId(workspace.id, target)
  // An offline check proves that no write occurred, so it is safe to briefly
  // wait for a hidden/new target to mount. Once a semantic write is attempted,
  // every non-acknowledged result is final or uncertain and is never retried.
  for (let attempt = 0; attempt < 5 && !isLive(runtimeId); attempt++) {
    if (!stillArmed(workspace.id, revision, epoch)) return
    useStore.getState().setActiveWidget(target.id)
    await wait(1300)
  }
  if (!stillArmed(workspace.id, revision, epoch)) return
  if (!isLive(runtimeId)) {
    boundedSet(deliveries, deliveryId, 'offline')
    notify('ccanvas flow stalled', `${target.title || 'Agent'} is offline; nothing was sent.`)
    return
  }

  boundedSet(deliveries, deliveryId, 'pending')
  const result = await deliverPrompt(runtimeId, prompt, deliveryId)
  boundedSet(deliveries, deliveryId, result.status)
  if (result.status === 'accepted') return
  const detail = result.error ? `: ${result.error}` : ''
  if (result.status === 'uncertain') {
    notify('ccanvas flow uncertain', `${target.title || 'Agent'} may have accepted the prompt; it was not retried${detail}`)
  } else {
    notify('ccanvas flow rejected', `${target.title || 'Agent'} did not accept the prompt${detail}`)
  }
}

function fireTarget(
  workspace: Workspace,
  targetId: string,
  edges: ArrowElement[],
  join: JoinState,
  revision: string,
) {
  if (!allowFire()) return
  const target = workspace.elements.find(element => element.id === targetId)
  if (!isAgent(target)) return
  const prompt = edges
    .slice()
    .sort((a, b) => a.z - b.z)
    .map(edge => edgeText(edge, join.edges.get(edge.id)?.output ?? ''))
    .map(text => text.trim())
    .filter(Boolean)
    .join('\n\n')

  const targetKey = runtimeFlowId(workspace.id, targetId)
  satisfied.delete(targetKey)
  targetEpochs.set(targetKey, join.epoch + 1)
  if (!prompt) {
    notify('ccanvas flow', `${target.title || 'Agent'} triggered without a prompt or output.`)
    return
  }

  const sourceKeys = edges.map(edge => join.edges.get(edge.id)?.sourceRunKey ?? '').sort()
  const deliveryId = `flow-${hash(JSON.stringify([revision, sourceKeys, edges.map(edge => edge.id).sort(), targetId]))}`
  const epoch = flowStateEpoch
  void deliverFlow(workspace, target, prompt, deliveryId, revision, epoch)
}

/** Consume one authoritative settled run. Duplicate/replayed run identities are ignored. */
export async function onAgentRunSettled(
  run: SettledAgentRun,
  expectation?: { revision: string; epoch: number },
): Promise<void> {
  if (!useStore.getState().flowsEnabled) return
  if (!run.runId || !Number.isSafeInteger(run.generation) || run.generation < 0) return
  const workspace = useStore.getState().tabs.find(tab => tab.id === run.workspaceId)
  if (!workspace) return
  const revision = ensureGraphRevision(workspace)
  if (
    expectation
    && (expectation.revision !== revision || expectation.epoch !== flowStateEpoch)
  ) return
  const runKey = `${run.workspaceId}:${run.sourceId}:${run.generation}:${run.runId}`
  if (seenRuns.has(runKey)) return
  boundedSet(seenRuns, runKey, true)
  if (run.outcome === 'aborted') return

  const outgoing = flowEdges(workspace, { from: run.sourceId })
  if (!outgoing.length) return
  const touchedTargets = new Map<string, Set<string>>()
  const now = Date.now()
  for (const edge of outgoing) {
    if (!evaluateCondition(edge, run.assistantText, run.outcome)) continue
    const targetId = edge.to!.id
    const targetKey = runtimeFlowId(workspace.id, targetId)
    let join = satisfied.get(targetKey)
    if (!join || join.revision !== revision || now - join.createdAt > MAX_JOIN_AGE_MS) {
      join = {
        revision,
        epoch: targetEpochs.get(targetKey) ?? 0,
        createdAt: now,
        edges: new Map(),
      }
      satisfied.set(targetKey, join)
    }
    // First completion wins for this edge/epoch. A later source run cannot
    // silently replace evidence while the remaining AND inputs are pending.
    if (!join.edges.has(edge.id)) join.edges.set(edge.id, {
      output: wantsOutput(edge) ? run.assistantText : '',
      sourceRunKey: runKey,
    })
    const touched = touchedTargets.get(targetId) ?? new Set<string>()
    touched.add(edge.id)
    touchedTargets.set(targetId, touched)
  }

  if (!stillArmed(workspace.id, revision, flowStateEpoch)) return
  for (const [targetId, touched] of touchedTargets) {
    const incoming = flowEdges(workspace, { to: targetId })
    const join = satisfied.get(runtimeFlowId(workspace.id, targetId))
    if (!join || !incoming.length || join.revision !== revision) continue
    const ready = incoming.filter(edge => join.edges.has(edge.id))
    const triggeredAny = ready.filter(edge => touched.has(edge.id) && edge.flow?.join === 'any')
    const allFire = incoming.every(edge => join.edges.has(edge.id))
    if (triggeredAny.length) fireTarget(workspace, targetId, triggeredAny, join, revision)
    else if (allFire) fireTarget(workspace, targetId, ready, join, revision)
  }
}

/** Claude compatibility adapter: quiet-screen turn plus transcript extraction. */
export async function onAgentTurnComplete(
  sourceId: string,
  turnIndex: number,
  tail: string,
  workspaceId?: string,
) {
  if (!useStore.getState().flowsEnabled) return
  const workspace = workspaceId
    ? useStore.getState().tabs.find(tab => tab.id === workspaceId) ?? null
    : tabContaining(sourceId)
  if (!workspace) return
  const source = workspace.elements.find(element => element.id === sourceId)
  if (!isAgent(source)) return
  const revision = ensureGraphRevision(workspace)
  const epoch = flowStateEpoch
  const transcriptText = await readLastClaudeAssistant(source)
  if (!stillArmed(workspace.id, revision, epoch)) return
  await onAgentRunSettled({
    sourceId,
    workspaceId: workspace.id,
    harness: source.harness === 'pi' ? 'pi' : 'claude',
    generation: 0,
    runId: String(turnIndex),
    outcome: 'completed',
    assistantText: transcriptText ?? cleanAgentOutput(tail),
  }, { revision, epoch })
}
