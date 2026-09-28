import type { ArrowElement, ArrowFlow, CanvasElement, FlowCondition, WidgetElement, WidgetKind, Workspace } from './types'
import { useStore, WIDGET_SIZE } from '../store/workspace'
import { newId } from './id'
import { agentRuntimeId, deliverPrompt, useAgents } from './agents'
import { browserNameOf, uniqueBrowserName } from './browser-agent'
import { widgetKindForFile } from './filetypes'

// Host side of the `canvas` Pi tool: agents create panels next to themselves,
// wired to them with arrows. The rule that makes this safe: an agent may only
// connect, message or close itself and elements it spawned. It can never draw
// an arrow into a panel the user created (which would, for example, grant it
// access to the user's own browsers).

export const CANVAS_LIMITS = {
  /** Live agents one agent may have spawned at once. */
  maxSpawnedAgents: 6,
  /** Everything one agent may have spawned at once. */
  maxSpawned: 30,
  /** user agent → spawned → spawned: no deeper. */
  maxDepth: 3,
  /** Spawns per agent per minute. */
  maxSpawnsPerMinute: 12,
} as const

const spawnTimes = new Map<string, number[]>()
const launchPrompts = new Map<string, string>()

/** A spawned agent's first prompt, submitted once when its runtime connects. Not persisted. */
export function takeLaunchPrompt(workspaceId: string, widgetId: string): string | undefined {
  const key = `${workspaceId}:${widgetId}`
  const prompt = launchPrompts.get(key)
  launchPrompts.delete(key)
  return prompt
}

const isWidget = (element: CanvasElement | undefined): element is WidgetElement =>
  !!element && element.type === 'widget'

/** How many agent spawns separate this agent from one the user created. */
export function spawnDepth(workspace: Workspace, agentId: string): number {
  const byId = new Map(workspace.elements.map(element => [element.id, element]))
  let depth = 0
  let current = byId.get(agentId)
  const seen = new Set<string>()
  while (current?.spawnedBy && !seen.has(current.id) && depth < 20) {
    seen.add(current.id)
    depth += 1
    current = byId.get(current.spawnedBy)
  }
  return depth
}

/** Join `relative` under `base` and refuse anything that escapes it. POSIX paths. */
export function containedPath(base: string, relative: string | undefined): string | null {
  const root = base.replace(/\/+$/, '') || '/'
  if (!relative || relative === '.') return root
  if (/[\u0000-\u001f]/.test(relative)) return null
  const joined = relative.startsWith('/') ? relative : `${root}/${relative}`
  const parts: string[] = []
  for (const part of joined.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(part)
  }
  const resolved = `/${parts.join('/')}`
  return resolved === root || resolved.startsWith(root === '/' ? '/' : `${root}/`) ? resolved : null
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, pad: number) {
  return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y
}

/** First free slot to the right of the anchor, filling columns top-down. */
export function placeNear(elements: CanvasElement[], anchor: WidgetElement, w: number, h: number) {
  const widgets = elements.filter(isWidget)
  const gap = 60
  for (let column = 0; column < 6; column++) {
    for (let row = 0; row < 6; row++) {
      const slot = {
        x: anchor.x + anchor.w + gap + column * (Math.max(w, 480) + gap),
        y: anchor.y + row * (h + 40),
        w,
        h,
      }
      if (!widgets.some(widget => overlaps(slot, widget, 20))) return { x: slot.x, y: slot.y }
    }
  }
  return { x: anchor.x, y: anchor.y + anchor.h + gap }
}

function connector(from: string, to: string, spawnedBy: string, flow?: ArrowFlow, color?: string): ArrowElement {
  return {
    id: newId(),
    type: 'arrow',
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 0,
    color: color ?? '#c89bd6',
    size: 2,
    from: { id: from },
    to: { id: to },
    z: 0,
    spawnedBy,
    ...(flow ? { flow } : {}),
  }
}

const str = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined

const MODEL_PART = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/
const FLOW_CONDITIONS: FlowCondition[] = ['always', 'success', 'failure', 'match', 'runtime-error']

function label(element: CanvasElement): string {
  if (!isWidget(element)) return `${element.type} ${element.id}`
  if (element.kind === 'web') return `browser "${browserNameOf(element)}"${element.url ? ` ${element.url}` : ''}`
  return `${element.kind} "${element.title}"`
}

export type CanvasRequest = { action: string; args: Record<string, unknown> }
export type CanvasHost = { workspaceId: string; agentId: string }

function context(host: CanvasHost) {
  const workspace = useStore.getState().tabs.find(tab => tab.id === host.workspaceId)
  if (!workspace) throw new Error('This agent\'s canvas is not open')
  const self = workspace.elements.find(element => element.id === host.agentId)
  if (!isWidget(self) || self.kind !== 'agent') throw new Error('This agent is no longer on the canvas')
  const owned = workspace.elements.filter(element => element.spawnedBy === host.agentId)
  const byId = new Map(workspace.elements.map(element => [element.id, element]))
  const connected = new Map<string, CanvasElement>()
  for (const element of workspace.elements) {
    if (element.type !== 'arrow' || !element.from || !element.to) continue
    const other = element.from.id === self.id ? element.to.id : element.to.id === self.id ? element.from.id : null
    const target = other ? byId.get(other) : undefined
    if (target && isWidget(target)) connected.set(target.id, target)
  }
  return { workspace, self, owned, connected: [...connected.values()] }
}

/** Resolve by id, exact title (case-insensitive) or browser name, among `pool`. */
function resolve(pool: CanvasElement[], ref: string | undefined, what: string): WidgetElement {
  if (!ref) throw new Error(`${what} requires a target`)
  const wanted = ref.trim().toLowerCase()
  // Spawned panels are usually also arrow-connected; count each element once.
  const widgets = [...new Map(pool.filter(isWidget).map(widget => [widget.id, widget])).values()]
  const exact = widgets.find(widget => widget.id === ref)
  if (exact) return exact
  const matches = widgets.filter(widget =>
    widget.title.toLowerCase() === wanted || (widget.kind === 'web' && browserNameOf(widget) === wanted))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) throw new Error(`"${ref}" is ambiguous; use one of these ids: ${matches.map(match => match.id).join(', ')}`)
  throw new Error(`No ${what} target "${ref}" among this agent's spawned or connected panels. Use action "list".`)
}

function checkSpawnBudget(host: CanvasHost, workspace: Workspace, owned: CanvasElement[], kind: WidgetKind) {
  const now = Date.now()
  const recent = (spawnTimes.get(host.agentId) ?? []).filter(time => now - time < 60_000)
  if (recent.length >= CANVAS_LIMITS.maxSpawnsPerMinute) throw new Error('Spawn rate limit reached; wait a minute')
  if (owned.filter(isWidget).length >= CANVAS_LIMITS.maxSpawned) throw new Error(`This agent already has ${CANVAS_LIMITS.maxSpawned} spawned panels; close some first`)
  if (kind === 'agent') {
    if (owned.filter(element => isWidget(element) && element.kind === 'agent').length >= CANVAS_LIMITS.maxSpawnedAgents) {
      throw new Error(`This agent already has ${CANVAS_LIMITS.maxSpawnedAgents} spawned agents; close some first`)
    }
    if (spawnDepth(workspace, host.agentId) + 1 >= CANVAS_LIMITS.maxDepth) {
      throw new Error('Spawn depth limit reached: agents spawned by spawned agents cannot spawn more agents')
    }
  }
  spawnTimes.set(host.agentId, [...recent, now])
}

/** Execute one `canvas` action for an agent. Returns text for the model. */
export async function executeCanvasRequest(host: CanvasHost, request: CanvasRequest): Promise<string> {
  const store = useStore.getState()
  const { workspace, self, owned, connected } = context(host)
  const base = self.cwd || workspace.dir || ''
  const args = request.args

  const spawn = (kind: WidgetKind, init: Partial<WidgetElement>) => {
    checkSpawnBudget(host, workspace, owned, kind)
    const { w, h } = WIDGET_SIZE[kind]
    const current = useStore.getState().tabs.find(tab => tab.id === workspace.id) ?? workspace
    const position = placeNear(current.elements, self, w, h)
    const id = store.spawnWidgetInTab(workspace.id, kind, position.x, position.y, { ...init, spawnedBy: self.id })
    if (!id) throw new Error('Could not add the panel to this canvas')
    store.addElementsInTab(workspace.id, [connector(self.id, id, self.id, undefined, self.color)])
    return id
  }

  switch (request.action) {
    case 'list': {
      const lines = [`This agent: "${self.title}" (id ${self.id}) in ${base || 'the canvas folder'}`]
      lines.push('', `Spawned by this agent (${owned.filter(isWidget).length}):`)
      for (const element of owned.filter(isWidget)) lines.push(`- ${element.id}: ${label(element)}`)
      const others = connected.filter(element => element.spawnedBy !== self.id)
      lines.push('', `Connected by arrows but not spawned (${others.length}):`)
      for (const element of others) lines.push(`- ${element.id}: ${label(element)}`)
      lines.push('', `Agent flows are ${useStore.getState().flowsEnabled ? 'running' : 'paused'}.`)
      return lines.join('\n')
    }

    case 'spawn_agent': {
      const title = str(args.title, 120) ?? `${self.title} · helper`
      const prompt = str(args.prompt, 32 * 1024)
      const cwd = containedPath(base, str(args.cwd, 4096))
      if (!cwd) throw new Error('cwd must stay inside this agent\'s folder')
      const provider = str(args.provider, 256)
      const model = str(args.model, 1024)
      if ((provider && !MODEL_PART.test(provider)) || (model && !MODEL_PART.test(model))) throw new Error('Invalid provider or model')
      const id = spawn('agent', {
        title,
        color: self.color,
        cwd,
        provider: provider ?? (model ? undefined : self.provider),
        model: model ?? (provider ? undefined : self.model),
        ...(prompt ? { promptDraft: prompt } : {}),
      })
      const start = prompt && args.start !== false
      if (start) launchPrompts.set(`${workspace.id}:${id}`, prompt)
      let returning = ''
      if (args.return_output === true) {
        store.addElementsInTab(workspace.id, [connector(id, self.id, self.id, {
          enabled: true,
          when: 'always',
          prompt: `Result from "${title}":\n{{output}}`,
        }, self.color)])
        returning = useStore.getState().flowsEnabled
          ? ' Its finished output will be sent back to you automatically.'
          : ' A return flow was added, but agent flows are paused; ask the user to resume flows (⌘K) for results to return automatically.'
      }
      return `Spawned agent "${title}" (id ${id}) in ${cwd}.${start ? ' It starts on your prompt once its runtime connects.' : prompt ? ' Its prompt is an unsent draft.' : ''}${returning}`
    }

    case 'spawn_browser': {
      const raw = str(args.url, 8192)
      const url = raw
        ? (/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : /^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(raw) ? `http://${raw}` : `https://${raw}`)
        : ''
      if (url && !/^https?:\/\//i.test(url)) throw new Error('Browsers only open http(s) URLs')
      const name = uniqueBrowserName(workspace.elements, str(args.name, 64) ?? 'browser')
      const id = spawn('web', { url, browserName: name, title: str(args.title, 120) ?? name })
      return `Spawned browser "${name}" (id ${id})${url ? ` at ${url}` : ''}, connected to you. Drive it with canvas_browser browser="${name}".`
    }

    case 'spawn_note': {
      const text = typeof args.text === 'string' && args.text.length <= 20 * 1024 ? args.text : undefined
      if (!text) throw new Error('spawn_note requires text (up to 20 KiB)')
      const id = spawn('note', { note: text, title: str(args.title, 120) ?? 'note' })
      return `Spawned note (id ${id}).`
    }

    case 'spawn_file': {
      const path = containedPath(base, str(args.path, 4096))
      if (!path || path === base) throw new Error('spawn_file requires a file path inside this agent\'s folder')
      const kind = widgetKindForFile(path)
      const id = spawn(kind, { path, title: str(args.title, 120) ?? path.split('/').pop() ?? path })
      return `Opened ${path} as a ${kind} panel (id ${id}).`
    }

    case 'spawn_terminal': {
      const cwd = containedPath(base, str(args.cwd, 4096))
      if (!cwd) throw new Error('cwd must stay inside this agent\'s folder')
      const id = spawn('terminal', { cwd, title: str(args.title, 120) ?? 'terminal' })
      return `Spawned terminal (id ${id}) in ${cwd}. It is a shell for the user; run your own commands with your tools.`
    }

    case 'connect': {
      const pool = [self, ...owned]
      const from = args.from ? resolve(pool, str(args.from, 512), 'connect') : self
      const to = resolve(pool, str(args.to, 512), 'connect')
      if (from.id === to.id) throw new Error('Cannot connect an element to itself')
      if (from.id !== self.id && to.id !== self.id && (from.spawnedBy !== self.id || to.spawnedBy !== self.id)) {
        throw new Error('Arrows may only join this agent and panels it spawned')
      }
      const when = typeof args.when === 'string' && FLOW_CONDITIONS.includes(args.when as FlowCondition)
        ? args.when as FlowCondition
        : undefined
      const flowPrompt = str(args.flow_prompt, 8192)
      const agents = from.kind === 'agent' && to.kind === 'agent'
      if ((when || flowPrompt) && !agents) throw new Error('Flow logic is only valid between two agents')
      const flow: ArrowFlow | undefined = agents && (when || flowPrompt)
        ? { enabled: true, when: when ?? 'always', ...(flowPrompt ? { prompt: flowPrompt } : {}) }
        : undefined
      store.addElementsInTab(workspace.id, [connector(from.id, to.id, self.id, flow, self.color)])
      const paused = flow && !useStore.getState().flowsEnabled ? ' Agent flows are paused until the user resumes them.' : ''
      return `Connected ${label(from)} → ${label(to)}${flow ? ` with flow "${flow.when}"` : ''}.${paused}`
    }

    case 'message': {
      const target = resolve([...owned, ...connected], str(args.target, 512), 'message')
      if (target.kind !== 'agent') throw new Error('message targets an agent')
      const text = str(args.prompt, 32 * 1024)
      if (!text) throw new Error('message requires prompt')
      const result = await deliverPrompt(agentRuntimeId(workspace.id, target), text)
      if (result.status === 'accepted') return `Sent to "${target.title}".`
      if (result.status === 'offline') throw new Error(`"${target.title}" is not running yet; its canvas tab must be visible to start it`)
      throw new Error(`"${target.title}" did not accept the message${result.error ? `: ${result.error}` : ''}`)
    }

    case 'status': {
      const pool = [...new Map([...owned, ...connected]
        .filter((element): element is WidgetElement => isWidget(element) && element.kind === 'agent')
        .map(element => [element.id, element])).values()]
      const targets = args.target ? [resolve(pool, str(args.target, 512), 'status')] : pool
      if (!targets.length) return 'No spawned or connected agents.'
      const agents = useAgents.getState()
      return targets.map(target => {
        const runtimeId = agentRuntimeId(workspace.id, target)
        const metrics = agents.metrics[runtimeId]
        return `- "${target.title}" (id ${target.id}): ${agents.status[runtimeId] ?? 'off'}`
          + `${metrics ? `, ${metrics.runs} runs` : ''}`
          + `${agents.lastLine[runtimeId] ? ` — last: ${agents.lastLine[runtimeId]}` : ''}`
      }).join('\n')
    }

    case 'close': {
      const target = resolve(owned, str(args.target, 512), 'close')
      store.removeElementsInTab(workspace.id, [target.id])
      launchPrompts.delete(`${workspace.id}:${target.id}`)
      return `Closed ${label(target)}.`
    }

    default:
      throw new Error(`Unknown canvas action "${request.action}"`)
  }
}
