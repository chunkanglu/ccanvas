// Provider-neutral tracking camera. Claude retains bounded transcript polling;
// Pi feeds successful structured tool-call pairs from its companion.

import { useStore } from '../store/workspace'
import type { ArrowElement, WidgetElement } from './types'
import { WIDGET_ACCENT } from './types'
import { newId } from './id'
import { resolvePath, baseName } from './backend'
import { readTranscript, extractToolFiles, type ToolFile } from './transcript'
import { widgetKindForFile } from './filetypes'
import { boundsOfMany, clamp } from './geometry'
import { notify } from './agents'

export type StructuredToolEvent = {
  agentId: string
  workspaceId: string
  generation: number
  seq: number
  replayed: boolean
  phase: 'start' | 'update' | 'end'
  callId: string
  name: string
  input?: unknown
  isError?: boolean
  truncated?: boolean
  /** Absolute path resolved by the Pi companion from the live runtime cwd. */
  resolvedPath?: string
}

type PendingTool = { name: string; input: unknown; resolvedPath?: string }
type Session = {
  agentId: string
  workspaceId: string
  harness: 'pi' | 'claude'
  cursor: number
  generation?: number
  lastSeq: number
  pendingTools: Map<string, PendingTool>
  openedByPath: Map<string, string>
  blockedPaths: Set<string>
  placed: number
  stopped: boolean
  dispose: (() => void) | null
  cappedNotified: boolean
}

let session: Session | null = null

const MAX_SATELLITES = 20
const MAX_PATH_BYTES = 32 * 1024
const SAT_W = 360
const SAT_H = 280
const POLL_MS = 1000
const CHROME_H = 82
const viewport = () => ({ vw: window.innerWidth, vh: window.innerHeight - CHROME_H })
export const TRACKED_FILE_CHANGED_EVENT = 'ccanvas:tracked-file-changed'

function announceTrackedMutation(path: string, file: ToolFile) {
  if (!file.mutate || typeof window.dispatchEvent !== 'function' || typeof CustomEvent === 'undefined') return
  window.dispatchEvent(new CustomEvent(TRACKED_FILE_CHANGED_EVENT, { detail: { path } }))
}

export function trackingAgentId(): string | null {
  return session?.agentId ?? null
}
export function trackedFileCount(): number {
  return session?.openedByPath.size ?? 0
}

/** Explicit built-in mapping. Shell/custom tools are intentionally not guessed. */
export function structuredToolFile(name: string, input: unknown): ToolFile | null {
  const normalized = name.toLowerCase()
  if (normalized !== 'read' && normalized !== 'write' && normalized !== 'edit') return null
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const path = (input as Record<string, unknown>).path
  if (typeof path !== 'string' || !path || new TextEncoder().encode(path).byteLength > MAX_PATH_BYTES) return null
  if (/\u0000|[\r\n]/.test(path)) return null
  return { path, tool: normalized, mutate: normalized !== 'read' }
}

/** Refuse common credential/key locations before auto-opening a viewer. */
export function isSensitiveTrackedPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  const segments = normalized.split('/').filter(Boolean)
  const name = segments[segments.length - 1] ?? ''
  if (segments.some(segment => ['.ssh', '.aws'].includes(segment))) return true
  if (normalized.includes('/.config/gcloud/') || normalized.includes('/.pi/agent/auth')) return true
  if (/^\.env(?:\.|$)/.test(name)) return true
  if (/^(?:credentials?|secrets?)(?:\.[^.]+)?$/.test(name)) return true
  if (/^(?:id_rsa|id_ed25519|id_ecdsa)(?:\.pub)?$/.test(name)) return true
  return /\.(?:pem|p12|pfx|key)$/.test(name)
}

function orbitPos(agent: WidgetElement, index: number): { x: number; y: number } {
  const cx = agent.x + agent.w / 2
  const cy = agent.y + agent.h / 2
  const ring = Math.floor(index / 8)
  const slot = index % 8
  const radius = Math.max(agent.w, agent.h) / 2 + 280 + ring * 260
  const angle = ((-90 + slot * 45) * Math.PI) / 180
  return { x: cx + Math.cos(angle) * radius - SAT_W / 2, y: cy + Math.sin(angle) * radius - SAT_H / 2 }
}

function trackArrow(agent: WidgetElement, targetId: string, file: ToolFile): ArrowElement {
  return {
    id: newId(), type: 'arrow', x1: 0, y1: 0, x2: 0, y2: 0,
    color: agent.color ?? WIDGET_ACCENT.agent,
    size: 2,
    dashed: true,
    from: { id: agent.id },
    to: { id: targetId },
    label: file.mutate ? undefined : 'read',
    z: 0,
    trackOf: agent.id,
  }
}

function frameAgent(agentId: string) {
  const state = useStore.getState()
  const workspace = state.active()
  const agent = workspace?.elements.find(element => element.id === agentId)
  if (!agent || agent.type !== 'widget') return
  const { vw, vh } = viewport()
  const zoom = clamp(workspace!.camera.zoom, 0.5, 1)
  const cx = agent.x + agent.w / 2
  const cy = agent.y + agent.h / 2
  state.setCamera({ zoom, x: vw / 2 - cx * zoom, y: vh / 2 - cy * zoom })
}

function frameOrbit() {
  const current = session
  if (!current) return
  const state = useStore.getState()
  const workspace = state.active()
  if (!workspace || workspace.id !== current.workspaceId) return
  const ids = new Set<string>([current.agentId, ...current.openedByPath.values()])
  const bounds = boundsOfMany(workspace.elements.filter(element => ids.has(element.id)))
  if (!bounds) return
  const { vw, vh } = viewport()
  const pad = 120
  const zoom = clamp(Math.min(vw / (bounds.w + pad * 2), vh / (bounds.h + pad * 2)), 0.1, 1.3)
  const cx = bounds.x + bounds.w / 2
  const cy = bounds.y + bounds.h / 2
  state.setCamera({ zoom, x: vw / 2 - cx * zoom, y: vh / 2 - cy * zoom })
}

function processTrackedFile(current: Session, file: ToolFile, resolvedPath?: string) {
  if (session !== current || current.stopped) return
  const state = useStore.getState()
  const workspace = state.active()
  if (!workspace || workspace.id !== current.workspaceId) return
  const agent = workspace.elements.find(
    (element): element is WidgetElement =>
      element.id === current.agentId && element.type === 'widget' && element.kind === 'agent',
  )
  if (!agent) return

  const absolute = resolvedPath ?? resolvePath(agent.cwd, file.path)
  if (isSensitiveTrackedPath(absolute)) {
    if (!current.blockedPaths.has(absolute)) {
      current.blockedPaths.add(absolute)
      notify('ccanvas tracking', `Refused to auto-open sensitive file ${baseName(absolute)}.`)
    }
    return
  }
  const known = current.openedByPath.get(absolute)
  if (known) {
    state.bringToFront([known])
    announceTrackedMutation(absolute, file)
    return
  }
  const existing = workspace.elements.find(
    (element): element is WidgetElement =>
      element.type === 'widget' && !!element.path && resolvePath(element.cwd, element.path) === absolute,
  )
  if (existing) {
    current.openedByPath.set(absolute, existing.id)
    state.addElement(trackArrow(agent, existing.id, file))
    state.bringToFront([existing.id])
    announceTrackedMutation(absolute, file)
    frameOrbit()
    return
  }
  if (current.openedByPath.size >= MAX_SATELLITES) {
    if (!current.cappedNotified) {
      current.cappedNotified = true
      notify('ccanvas tracking', `Showing the first ${MAX_SATELLITES} files — stop and restart to reset the orbit.`)
    }
    return
  }

  const position = orbitPos(agent, current.placed++)
  const widgetId = newId()
  const widget: WidgetElement = {
    id: widgetId,
    type: 'widget',
    kind: widgetKindForFile(absolute),
    x: position.x,
    y: position.y,
    w: SAT_W,
    h: SAT_H,
    z: 0,
    title: baseName(absolute),
    path: absolute,
    cwd: agent.cwd,
    trackOf: agent.id,
  }
  state.addElements([widget, trackArrow(agent, widgetId, file)])
  current.openedByPath.set(absolute, widgetId)
  if (
    useStore.getState().trackingAgentId === current.agentId
    && useStore.getState().trackingAgentTabId === current.workspaceId
  ) frameOrbit()
}

/** Non-replayed successful Pi tool calls enter here from the companion. */
export function onStructuredToolEvent(event: StructuredToolEvent): void {
  const current = session
  if (
    !current
    || current.stopped
    || current.harness !== 'pi'
    || event.replayed
    || event.agentId !== current.agentId
    || event.workspaceId !== current.workspaceId
    || !Number.isSafeInteger(event.generation)
    || event.generation < 1
    || !Number.isSafeInteger(event.seq)
    || event.seq < 0
  ) return

  if (current.generation !== undefined && event.generation < current.generation) return
  if (current.generation !== event.generation) {
    current.generation = event.generation
    current.lastSeq = -1
    current.pendingTools.clear()
  }
  if (event.seq <= current.lastSeq) return
  current.lastSeq = event.seq

  const key = `${event.generation}:${event.callId}`
  if (event.phase === 'start') {
    const resolvedPath = typeof event.resolvedPath === 'string'
      && /^(?:\/|[A-Za-z]:[\\/])/.test(event.resolvedPath)
      ? event.resolvedPath
      : undefined
    if (!event.truncated || resolvedPath) {
      current.pendingTools.set(key, { name: event.name, input: event.input, resolvedPath })
    }
    return
  }
  if (event.phase !== 'end') return
  const pending = current.pendingTools.get(key)
  current.pendingTools.delete(key)
  if (!pending || event.isError !== false) return
  const file = structuredToolFile(
    pending.name,
    pending.resolvedPath ? { path: pending.resolvedPath } : pending.input,
  )
  if (file) processTrackedFile(current, file, pending.resolvedPath)
}

/** Claude compatibility polling. */
async function tickClaude() {
  const current = session
  if (!current || current.stopped || current.harness !== 'claude') return
  const state = useStore.getState()
  const workspace = state.active()
  if (!workspace || workspace.id !== current.workspaceId) return
  const agent = workspace.elements.find(
    (element): element is WidgetElement =>
      element.id === current.agentId && element.type === 'widget' && element.kind === 'agent',
  )
  if (!agent) return
  const content = await readTranscript(agent.cwd, agent.sessionId)
  if (session !== current || current.stopped || content == null) return
  const extracted = extractToolFiles(content, current.cursor)
  current.cursor = extracted.cursor
  for (const file of extracted.files) processTrackedFile(current, file)
}

export async function startTracking(agentId: string, workspaceId?: string): Promise<boolean> {
  stopTracking(false)
  const state = useStore.getState()
  const tab = workspaceId
    ? state.tabs.find(candidate => candidate.id === workspaceId)
    : state.tabs.find(candidate => candidate.elements.some(element => element.id === agentId))
  if (!tab) return false
  const agent = tab.elements.find(element => element.id === agentId)
  if (!agent || agent.type !== 'widget' || agent.kind !== 'agent') return false
  if (state.activeTabId !== tab.id) state.switchTab(tab.id)

  const harness = agent.harness === 'pi' ? 'pi' : 'claude'
  const seed = harness === 'claude' ? await readTranscript(agent.cwd, agent.sessionId) : null
  const cursor = seed ? extractToolFiles(seed, 0).cursor : 0
  const timer = harness === 'claude' ? setInterval(() => void tickClaude(), POLL_MS) : undefined
  session = {
    agentId,
    workspaceId: tab.id,
    harness,
    cursor,
    lastSeq: -1,
    pendingTools: new Map(),
    openedByPath: new Map(),
    blockedPaths: new Set(),
    placed: 0,
    stopped: false,
    dispose: timer ? () => clearInterval(timer) : null,
    cappedNotified: false,
  }
  frameAgent(agentId)
  if (harness === 'claude') void tickClaude()
  return true
}

export function stopTracking(cleanup: boolean) {
  const current = session
  if (!current) return
  current.stopped = true
  current.pendingTools.clear()
  current.dispose?.()
  session = null
  if (!cleanup) return
  const state = useStore.getState()
  const tab = state.tabs.find(candidate => candidate.id === current.workspaceId)
  if (!tab) return
  if (state.activeTabId !== tab.id) state.switchTab(tab.id)
  const ids = tab.elements.filter(element => element.trackOf === current.agentId).map(element => element.id)
  if (ids.length) state.removeElements(ids)
}
