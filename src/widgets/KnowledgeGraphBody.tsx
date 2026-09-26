import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { WidgetElement } from '../lib/types'
import { defaultDir, listDir, readFile, joinPath, pickDir } from '../lib/backend'
import { useStore } from '../store/workspace'
import {
  buildKnowledgeGraph,
  KNOWLEDGE_LIMITS,
  loadMarkdownKnowledge,
  parseKnowledgeNote,
  type KnowledgeGraph,
  type KnowledgeNode,
} from '../lib/knowledge-graph'

// A live, Obsidian-style force-directed graph over an explicit read-only source:
// legacy Claude project memory for existing widgets, or a user-selected
// Markdown folder. It never scans a whole vault by default and never invents a
// Pi memory convention.

type GNode = KnowledgeNode
type Graph = KnowledgeGraph
type LoadStatus = 'loading' | 'ok' | 'nobind' | 'empty' | 'nosource' | 'unreadable'

// Claude Code encodes a project's memory dir by the cwd with path separators
// (and the drive colon) turned into dashes — e.g. C:\Users\me\cc → C--Users-me-cc.
function slugFor(cwd: string): string {
  return cwd.replace(/[\\/:]/g, '-')
}

// Type → CSS custom property carrying its hue (defined on .mem-graph).
const HUE: Record<string, string> = {
  user: '--mg-user',
  reference: '--mg-reference',
  feedback: '--mg-feedback',
  project: '--mg-project',
}
const hueVar = (type: string): string => HUE[type] ?? '--mg-other'
const TYPE_ORDER = ['user', 'reference', 'feedback', 'project']

// Minimal markdown for the detail panel. Escape first; every substitution
// below only wraps already-escaped text, so note content cannot inject HTML.
function bodyToHtml(src: string): string {
  const esc = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[\[([^\]]+)\]\]/g, '<em>$1</em>')
    .replace(/(^|\n)[-*]\s+(.+)/g, '$1• $2')
    .split(/\n{2,}/)
    .map((p) => `<p>${p.trim().replace(/\n/g, '<br/>')}</p>`)
    .join('')
}

async function loadClaudeMemory(cwd: string | undefined): Promise<Graph | 'nobind' | 'empty'> {
  if (!cwd) return 'nobind'
  const home = await defaultDir()
  if (!home) return 'empty'
  const dir = joinPath(joinPath(joinPath(joinPath(home, '.claude'), 'projects'), slugFor(cwd)), 'memory')
  const entries = await listDir(dir)
  if (!entries) return 'empty'
  const files = entries
    .filter((e) => !e.is_dir && /\.md$/i.test(e.name) && e.name.toLowerCase() !== 'memory.md')
    .slice(0, KNOWLEDGE_LIMITS.maxNotes)
  if (files.length === 0) return 'empty'
  const texts = await Promise.all(files.map((f) => readFile(f.path)))
  const nodes: GNode[] = []
  files.forEach((f, i) => {
    const t = texts[i]
    if (t != null && t.length <= KNOWLEDGE_LIMITS.maxNoteChars) nodes.push(parseKnowledgeNote(f.name, t, 'reference'))
  })
  if (nodes.length === 0) return 'empty'
  return buildKnowledgeGraph(nodes, entries.length > files.length)
}

async function loadGraph(el: WidgetElement): Promise<Graph | Exclude<LoadStatus, 'loading' | 'ok'>> {
  if ((el.graphSource ?? 'claude-memory') === 'claude-memory') return loadClaudeMemory(el.cwd)
  if (!el.path) return 'nosource'
  const graph = await loadMarkdownKnowledge(el.path, { listDir, readFile })
  if (!graph) return 'unreadable'
  return graph.nodes.length ? graph : 'empty'
}

export function KnowledgeGraphBody({ el }: { el: WidgetElement }) {
  const mutateElement = useStore((s) => s.mutateElement)
  const source = el.graphSource ?? 'claude-memory'
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const graphRef = useRef<Graph>({ nodes: [], links: [], truncated: false, ambiguousLinks: 0 })
  const selRef = useRef<string | null>(null)

  const [status, setStatus] = useState<LoadStatus>('loading')
  const [notice, setNotice] = useState<string>()
  const [gen, setGen] = useState(0) // bumps on each successful load
  const [selected, setSelected] = useState<GNode | null>(null)
  const [types, setTypes] = useState<string[]>([])

  const openNode = (id: string) => {
    const n = graphRef.current.nodes.find((x) => x.id === id) ?? null
    selRef.current = n ? n.id : null
    setSelected(n)
  }

  // ---- load whenever the explicit source changes ----
  useEffect(() => {
    let alive = true
    setStatus('loading')
    setNotice(undefined)
    void loadGraph(el).then((res) => {
      if (!alive) return
      if (typeof res === 'string') {
        graphRef.current = { nodes: [], links: [], truncated: false, ambiguousLinks: 0 }
        setStatus(res)
        return
      }
      graphRef.current = res
      const present = Array.from(new Set(res.nodes.map((n) => n.type)))
      present.sort((a, b) => {
        const ia = TYPE_ORDER.indexOf(a), ib = TYPE_ORDER.indexOf(b)
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b)
      })
      setTypes(present.slice(0, 12))
      const notes: string[] = []
      if (res.truncated) notes.push(`bounded to ${KNOWLEDGE_LIMITS.maxNotes} notes / ${KNOWLEDGE_LIMITS.maxDepth} levels`)
      if (res.ambiguousLinks) notes.push(`${res.ambiguousLinks} ambiguous links skipped`)
      setNotice(notes.join(' · ') || undefined)
      selRef.current = null
      setSelected(null)
      setStatus('ok')
      setGen((g) => g + 1)
    })
    return () => {
      alive = false
    }
  }, [el.cwd, el.graphSource, el.path])

  const chooseFolder = async () => {
    const dir = await pickDir()
    if (!dir) return
    mutateElement(el.id, (widget) => {
      const graph = widget as WidgetElement
      graph.graphSource = 'markdown'
      graph.path = dir
    })
  }
  const useClaudeMemory = () => {
    mutateElement(el.id, (widget) => {
      const graph = widget as WidgetElement
      graph.graphSource = 'claude-memory'
    })
  }

  // ---- force sim + canvas render (runs while a graph is loaded) ----
  useEffect(() => {
    if (status !== 'ok') return
    const host = hostRef.current
    const cv = canvasRef.current
    if (!host || !cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const cs = getComputedStyle(host)
    const tok = (n: string) => cs.getPropertyValue(n).trim()

    const { nodes, links } = graphRef.current
    const byId = new Map(nodes.map((n) => [n.id, n]))
    let W = host.clientWidth || 800
    let H = host.clientHeight || 600
    let DPR = Math.min(window.devicePixelRatio || 1, 2)

    // seed layout
    nodes.forEach((n, i) => {
      if (n.hub) {
        n.x = W / 2; n.y = H / 2
      } else {
        const a = (i / nodes.length) * Math.PI * 2
        n.x = W / 2 + Math.cos(a) * Math.min(W, H) * 0.28
        n.y = H / 2 + Math.sin(a) * Math.min(W, H) * 0.28
      }
      n.vx = 0; n.vy = 0
    })

    const view = { x: 0, y: 0, k: 1 }
    const radius = (n: GNode) => (n.hub ? 24 : 16) + Math.min(n.deg, 6) * 1.6

    function fit() {
      W = host!.clientWidth || 800
      H = host!.clientHeight || 600
      DPR = Math.min(window.devicePixelRatio || 1, 2)
      cv!.width = W * DPR; cv!.height = H * DPR
      cv!.style.width = W + 'px'; cv!.style.height = H + 'px'
    }
    fit()

    // interaction state — declared before loop() so tick/draw don't hit the TDZ
    let hoverId: string | null = null
    let dragging: GNode | null = null
    let panning = false
    let panStart = { x: 0, y: 0 }
    let moved = false

    let alpha = 1
    function tick() {
      const cx = W / 2, cy = H / 2
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]
          const dx = a.x - b.x, dy = a.y - b.y
          const d2 = dx * dx + dy * dy || 0.01
          const d = Math.sqrt(d2)
          const rep = 24000 / d2
          const fx = (dx / d) * rep, fy = (dy / d) * rep
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy
        }
      }
      links.forEach(([ia, ib]) => {
        const a = byId.get(ia)!, b = byId.get(ib)!
        const dx = b.x - a.x, dy = b.y - a.y
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01
        const f = (d - 160) * 0.012
        const fx = (dx / d) * f, fy = (dy / d) * f
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy
      })
      nodes.forEach((n) => {
        if (n === dragging) return
        n.vx += (cx - n.x) * 0.006
        n.vy += (cy - n.y) * 0.006
        n.vx *= 0.86; n.vy *= 0.86
        n.x += n.vx * alpha; n.y += n.vy * alpha
      })
      alpha *= 0.985
      if (alpha < 0.02) alpha = 0.02
    }

    function draw() {
      ctx!.setTransform(DPR, 0, 0, DPR, 0, 0)
      ctx!.clearRect(0, 0, W, H)
      ctx!.save()
      ctx!.translate(view.x, view.y)
      ctx!.scale(view.k, view.k)

      const edge = tok('--line-hard') || '#2c3038'
      const hot = tok('--accent') || '#e8795a'
      const sel = selRef.current
      links.forEach(([ia, ib]) => {
        const a = byId.get(ia)!, b = byId.get(ib)!
        const active =
          (hoverId && (ia === hoverId || ib === hoverId)) || (sel && (ia === sel || ib === sel))
        ctx!.beginPath()
        ctx!.moveTo(a.x, a.y); ctx!.lineTo(b.x, b.y)
        ctx!.strokeStyle = active ? hot : edge
        ctx!.globalAlpha = active ? 0.9 : 0.5
        ctx!.lineWidth = active ? 2 : 1.2
        ctx!.stroke()
      })
      ctx!.globalAlpha = 1

      const bg = tok('--panel') || '#121419'
      const ink = tok('--ink') || '#e8e6e1'
      nodes.forEach((n) => {
        const r = radius(n)
        const hue = tok(hueVar(n.type)) || hot
        const isHot = n.id === hoverId || n.id === sel
        const neighbor = !!sel && links.some(
          ([a, b]) => (a === sel && b === n.id) || (b === sel && a === n.id),
        )
        const dim = !!sel && !isHot && !neighbor

        ctx!.globalAlpha = dim ? 0.3 : 1
        if (isHot) {
          ctx!.beginPath(); ctx!.arc(n.x, n.y, r + 9, 0, Math.PI * 2)
          ctx!.fillStyle = hue; ctx!.globalAlpha = 0.16; ctx!.fill(); ctx!.globalAlpha = 1
        }
        ctx!.beginPath(); ctx!.arc(n.x, n.y, r, 0, Math.PI * 2)
        ctx!.fillStyle = hue; ctx!.fill()
        ctx!.lineWidth = 2.5; ctx!.strokeStyle = bg; ctx!.stroke()
        if (n.hub) {
          ctx!.beginPath(); ctx!.arc(n.x, n.y, r * 0.4, 0, Math.PI * 2)
          ctx!.fillStyle = bg; ctx!.globalAlpha = dim ? 0.3 : 0.85; ctx!.fill()
          ctx!.globalAlpha = dim ? 0.3 : 1
        }
        ctx!.globalAlpha = dim ? 0.35 : 1
        ctx!.font = "600 12px ui-monospace, 'IBM Plex Mono', Menlo, monospace"
        ctx!.textAlign = 'center'; ctx!.textBaseline = 'top'
        ctx!.fillStyle = ink
        ctx!.fillText(n.label, n.x, n.y + r + 6)
      })
      ctx!.globalAlpha = 1
      ctx!.restore()
    }

    let raf = 0
    function loop() { tick(); draw(); raf = requestAnimationFrame(loop) }
    loop()

    // ---- interaction (state declared above, before loop) ----
    const toWorld = (px: number, py: number) => ({
      x: (px - view.x) / view.k,
      y: (py - view.y) / view.k,
    })
    function pickAt(px: number, py: number): GNode | null {
      const p = toWorld(px, py)
      let best: GNode | null = null, bd = Infinity
      nodes.forEach((n) => {
        const d = Math.hypot(n.x - p.x, n.y - p.y)
        if (d < radius(n) + 6 && d < bd) { bd = d; best = n }
      })
      return best
    }
    const localXY = (e: { clientX: number; clientY: number }) => {
      const rect = cv!.getBoundingClientRect()
      // account for ccanvas zoom: the widget may be CSS-scaled
      const sx = rect.width / (cv!.clientWidth || 1)
      const sy = rect.height / (cv!.clientHeight || 1)
      return { x: (e.clientX - rect.left) / sx, y: (e.clientY - rect.top) / sy }
    }

    function onMove(e: MouseEvent) {
      const { x, y } = localXY(e)
      if (dragging) {
        const p = toWorld(x, y)
        dragging.x = p.x; dragging.y = p.y; dragging.vx = 0; dragging.vy = 0
        alpha = Math.max(alpha, 0.4); moved = true; return
      }
      if (panning) {
        view.x += x - panStart.x; view.y += y - panStart.y
        panStart = { x, y }; moved = true; return
      }
      const hit = pickAt(x, y)
      hoverId = hit ? hit.id : null
      cv!.style.cursor = hit ? 'pointer' : 'grab'
    }
    function onDown(e: MouseEvent) {
      const { x, y } = localXY(e)
      moved = false
      const hit = pickAt(x, y)
      if (hit) dragging = hit
      else { panning = true; panStart = { x, y } }
    }
    function onUp() {
      if (dragging && !moved) openNode(dragging.id)
      else if (panning && !moved) { selRef.current = null; setSelected(null) }
      dragging = null; panning = false
    }
    function onWheel(e: WheelEvent) {
      e.preventDefault()
      const { x, y } = localXY(e)
      const f = e.deltaY < 0 ? 1.1 : 0.9
      const nk = Math.min(2.6, Math.max(0.4, view.k * f))
      const wx = (x - view.x) / view.k, wy = (y - view.y) / view.k
      view.k = nk
      view.x = x - wx * view.k; view.y = y - wy * view.k
    }

    cv.addEventListener('mousemove', onMove)
    cv.addEventListener('mousedown', onDown)
    window.addEventListener('mouseup', onUp)
    cv.addEventListener('wheel', onWheel, { passive: false })
    const ro = new ResizeObserver(() => fit())
    ro.observe(host)

    return () => {
      cancelAnimationFrame(raf)
      cv.removeEventListener('mousemove', onMove)
      cv.removeEventListener('mousedown', onDown)
      window.removeEventListener('mouseup', onUp)
      cv.removeEventListener('wheel', onWheel)
      ro.disconnect()
    }
  }, [status, gen])

  const neighborsOf = (id: string): GNode[] => {
    const out: GNode[] = []
    graphRef.current.links.forEach(([a, b]) => {
      if (a === id) { const n = graphRef.current.nodes.find((x) => x.id === b); if (n) out.push(n) }
      else if (b === id) { const n = graphRef.current.nodes.find((x) => x.id === a); if (n) out.push(n) }
    })
    return out
  }

  return (
    <div className="mem-graph" ref={hostRef}>
      <canvas className="mem-graph__canvas" ref={canvasRef} />

      <div className="mem-graph__title">
        <div className="mem-graph__eyebrow">
          {source === 'markdown'
            ? `markdown · ${el.path?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'choose folder'}`
            : 'claude · memory (legacy)'}
        </div>
        <div className="mem-graph__h1">Knowledge Graph</div>
        <div className="mem-graph__sources">
          <button className="mem-graph__source" onClick={() => void chooseFolder()}>
            {source === 'markdown' && el.path ? 'Change folder…' : 'Markdown folder…'}
          </button>
          {source !== 'claude-memory' && (
            <button className="mem-graph__source" onClick={useClaudeMemory}>
              Legacy Claude memory
            </button>
          )}
        </div>
        {notice && <div className="mem-graph__notice">{notice}</div>}
      </div>

      {status === 'ok' && types.length > 0 && (
        <div className="mem-graph__legend">
          <div className="mem-graph__lhead">Node types</div>
          {types.map((t) => (
            <div className="mem-graph__row" key={t}>
              <span className="mem-graph__dot" style={{ background: `var(${hueVar(t)})` }} />
              {t}
            </div>
          ))}
        </div>
      )}

      {status === 'loading' && <div className="mem-graph__msg">reading knowledge source…</div>}
      {status === 'nosource' && (
        <div className="mem-graph__msg">
          Choose a Markdown folder to graph.
          <div className="mem-graph__msg-sub">
            Pick a scoped notes folder; ccanvas reads it read-only and does not scan a whole vault by default.
          </div>
        </div>
      )}
      {status === 'unreadable' && (
        <div className="mem-graph__msg">The selected folder could not be read.</div>
      )}
      {status === 'nobind' && (
        <div className="mem-graph__msg">
          Bind a folder to this canvas to show its Claude memory.
        </div>
      )}
      {status === 'empty' && (
        <div className="mem-graph__msg">
          {source === 'markdown'
            ? 'No Markdown notes found in this folder.'
            : 'No Claude memory nodes found for this folder yet.'}
          <div className="mem-graph__msg-sub">
            {source === 'markdown'
              ? 'Hidden and dependency/build folders are skipped.'
              : 'Legacy Claude memory remains available for existing graph widgets.'}
          </div>
        </div>
      )}

      {selected && (
        <aside
          className="mem-graph__panel"
          style={{ '--nodehue': `var(${hueVar(selected.type)})` } as CSSProperties}
        >
          <button className="mem-graph__close" aria-label="Close" onClick={() => { selRef.current = null; setSelected(null) }}>
            ✕
          </button>
          <span className="mem-graph__badge">{selected.type}</span>
          <h2 className="mem-graph__ptitle">{selected.label}</h2>
          {source === 'markdown' && <div className="mem-graph__path">{selected.id}.md</div>}
          {selected.desc && <p className="mem-graph__pdesc">{selected.desc}</p>}
          <div
            className="mem-graph__pbody"
            dangerouslySetInnerHTML={{ __html: bodyToHtml(selected.body) }}
          />
          <div className="mem-graph__links">
            <div className="mem-graph__lhead">Linked nodes</div>
            {neighborsOf(selected.id).length === 0 ? (
              <span className="mem-graph__muted">— none —</span>
            ) : (
              neighborsOf(selected.id).map((n) => (
                <button className="mem-graph__chip" key={n.id} onClick={() => openNode(n.id)}>
                  <span className="mem-graph__cdot" style={{ background: `var(${hueVar(n.type)})` }} />
                  {n.label}
                </button>
              ))
            )}
          </div>
        </aside>
      )}
    </div>
  )
}
