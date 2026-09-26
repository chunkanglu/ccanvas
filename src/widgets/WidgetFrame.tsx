import { useEffect, useRef, useState } from 'react'
import type { WidgetElement, WidgetKind } from '../lib/types'
import { WIDGET_ACCENT } from '../lib/types'
import { useStore, selectActive } from '../store/workspace'
import { elementBounds, edgeLines, snapValue } from '../lib/geometry'
import {
  IconClose,
  IconNote,
  IconTerminal,
  IconWeb,
  IconAgent,
  IconFiles,
  IconDiff,
  IconEditor,
  IconDoc,
  IconLog,
  IconLock,
  IconSettings,
  IconPr,
  IconRun,
  IconIssue,
  IconChecks,
  IconDatabase,
  IconData,
  IconPlot,
  IconChat,
  IconVideo,
  IconClaude,
  IconInfo,
} from '../ui/icons'
import { agentRuntimeId, useAgents, sendTo, sendPrompt, renameSession, isLive as isSessionLive, type AgentMetrics, type PiSessionUsage } from '../lib/agents'
import { CANVAS_FILE_DROP_EVENT } from '../lib/canvas-file-drag'
import { NoteBody } from './NoteBody'
import { WebBody } from './WebBody'
import { TerminalBody } from './TerminalBody'
import { FilesBody } from './FilesBody'
import { DiffBody } from './DiffBody'
import { EditorBody } from './EditorBody'
import { DocBody } from './DocBody'
import { LogBody } from './LogBody'
import { PrBody } from './PrBody'
import { IssuesBody } from './IssuesBody'
import { RunsBody } from './RunsBody'
import { RunnerBody } from './RunnerBody'
import { SqlBody } from './SqlBody'
import { DataBody } from './DataBody'
import { PlotBody } from './PlotBody'
import { TranscriptBody } from './TranscriptBody'
import { VideoBody } from './VideoBody'
import { MediaInfoBody } from './MediaInfoBody'
import { KnowledgeGraphBody } from './KnowledgeGraphBody'
import { WidgetErrorBoundary } from '../ui/WidgetErrorBoundary'

const KIND_ICON: Record<WidgetKind, (p: { className?: string; size?: number }) => JSX.Element> = {
  terminal: IconTerminal,
  agent: IconAgent,
  web: IconWeb,
  note: IconNote,
  files: IconFiles,
  diff: IconDiff,
  editor: IconEditor,
  doc: IconDoc,
  log: IconLog,
  pr: IconPr,
  issues: IconIssue,
  runs: IconChecks,
  runner: IconRun,
  sql: IconDatabase,
  data: IconData,
  plot: IconPlot,
  transcript: IconChat,
  video: IconVideo,
  mediainfo: IconInfo,
  claude: IconClaude,
}

const MIN_W = 220
const MIN_H = 150

export function WidgetFrame({
  workspaceId,
  el,
  selected,
  onStartMove,
  visible = true,
}: {
  workspaceId: string
  el: WidgetElement
  selected: boolean
  onStartMove: (e: React.PointerEvent, id: string) => void
  /** is this widget's tab currently shown? */
  visible?: boolean
}) {
  const tool = useStore((s) => s.tool)
  const activeWidgetId = useStore((s) => s.activeWidgetId)
  const setSelection = useStore((s) => s.setSelection)
  const setActiveWidget = useStore((s) => s.setActiveWidget)
  const bringToFront = useStore((s) => s.bringToFront)
  const removeElements = useStore((s) => s.removeElements)
  const mutateElement = useStore((s) => s.mutateElement)
  const beginHistory = useStore((s) => s.beginHistory)
  const openAgentWizard = useStore((s) => s.openAgentWizard)

  const active = visible && activeWidgetId === el.id
  const Icon = KIND_ICON[el.kind]
  const accent = el.color ?? WIDGET_ACCENT[el.kind]
  // terminals/agents are live — interact on a single click, drag by the title bar
  const isTerminal = el.kind === 'terminal' || el.kind === 'agent'
  const sessionId = agentRuntimeId(workspaceId, el)
  // app-like panels also interact on a single click (no double-click shield)
  const isLive =
    isTerminal ||
    el.kind === 'files' ||
    el.kind === 'diff' ||
    el.kind === 'editor' ||
    el.kind === 'doc' ||
    el.kind === 'log' ||
    el.kind === 'pr' ||
    el.kind === 'issues' ||
    el.kind === 'runs' ||
    el.kind === 'runner' ||
    el.kind === 'sql' ||
    el.kind === 'data' ||
    el.kind === 'plot' ||
    el.kind === 'transcript' ||
    el.kind === 'claude' ||
    el.kind === 'video' ||
    el.kind === 'mediainfo'
  // notes are also single-click, but manage their own pointer handling
  // (toggle a checkbox vs. enter edit) so they don't use the generic capture
  const isNote = el.kind === 'note'
  const folder = el.cwd
    ? el.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
    : null

  const [renaming, setRenaming] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const [name, setName] = useState(el.title)
  const titleRef = useRef<HTMLInputElement>(null)
  const dropBodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => setName(el.title), [el.title])
  useEffect(() => {
    if (renaming) {
      titleRef.current?.focus()
      titleRef.current?.select()
    }
  }, [renaming])

  const select = () => {
    setSelection([el.id])
    bringToFront([el.id])
  }

  // Start a move. If this widget is already part of a (multi) selection, keep
  // that selection so everything drags together; shift toggles membership;
  // otherwise select just this one. Mirrors the canvas vector-drag behaviour.
  const grab = (e: React.PointerEvent) => {
    e.stopPropagation()
    const cur = useStore.getState().selection
    if (e.shiftKey) {
      setSelection(cur.includes(el.id) ? cur.filter((x) => x !== el.id) : [...cur, el.id])
    } else if (!cur.includes(el.id)) {
      setSelection([el.id])
    }
    bringToFront([el.id])
    onStartMove(e, el.id)
  }

  // only widgets that aren't live or self-managed (i.e. web) keep the shield
  const shielded = !isLive && !isNote && (!active || tool !== 'select')

  // live bodies: a single click selects + focuses the widget and keeps the
  // event from reaching the canvas (which would deselect / start a marquee)
  const onLiveBodyCapture = () => {
    if (tool !== 'select') return
    select()
    setActiveWidget(el.id)
  }
  const onLiveBodyDown = (e: React.PointerEvent) => {
    if (tool === 'select') e.stopPropagation()
  }

  // Drop onto an agent/terminal to feed it context. File-tree and diff rows
  // use app-local pointer tracking because WKWebView does not reliably start
  // HTML DnD inside the transformed canvas; prompt rows retain native DnD.
  const onBodyDragOver = (e: React.DragEvent) => {
    // WebKit can hide custom MIME types during drag-over. Accept the drag here
    // and classify its payload on drop, using text/plain as the fallback.
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }
  const onBodyDragLeave = (e: React.DragEvent) => {
    const next = e.relatedTarget
    if (next instanceof Node && e.currentTarget.contains(next)) return
    setDropActive(false)
  }
  const insertDroppedPath = (path: string) => {
    const base = el.cwd ? el.cwd.replace(/[\\/]+$/, '') : ''
    let rel = base && path.startsWith(base) ? path.slice(base.length + 1) : path
    rel = rel.replace(/\\/g, '/')
    if (el.kind === 'agent' && el.harness === 'pi') {
      sendPrompt(sessionId, `Please read and use this file:\n${path}\n`, false)
    } else {
      sendTo(sessionId, `@${rel} `)
    }
    select()
    setActiveWidget(el.id)
  }

  useEffect(() => {
    const body = dropBodyRef.current
    if (!body || !isTerminal) return
    const receivePointerDrop = (event: Event) => {
      const path = (event as CustomEvent<{ path?: unknown }>).detail?.path
      if (typeof path !== 'string' || !path || path.length > 32_768) return
      insertDroppedPath(path)
    }
    body.addEventListener(CANVAS_FILE_DROP_EVENT, receivePointerDrop)
    return () => body.removeEventListener(CANVAS_FILE_DROP_EVENT, receivePointerDrop)
  })

  const onBodyDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDropActive(false)
    const explicitPath = e.dataTransfer.getData('application/x-ccanvas-file')
    const explicitPrompt = e.dataTransfer.getData('application/x-ccanvas-prompt')
    const plain = e.dataTransfer.getData('text/plain')
    const fallbackPath = /^(?:\/|[A-Za-z]:[\\/])/.test(plain) ? plain : ''
    const path = explicitPath || fallbackPath
    const prompt = explicitPrompt || (!path ? plain : '')
    if (!path && !prompt) return
    if (path) insertDroppedPath(path)
    else {
      // paste the snippet without auto-submitting, so it can be reviewed/edited
      sendPrompt(sessionId, prompt, false)
      select()
      setActiveWidget(el.id)
    }
  }

  const commitName = () => {
    const t = name.trim() || el.title
    if (t !== el.title) {
      beginHistory()
      mutateElement(el.id, (w) => {
        ;(w as WidgetElement).title = t
      })
      // tell a live claude agent its new name
      if (el.kind === 'agent' && isSessionLive(sessionId)) renameSession(sessionId, t)
    }
    setRenaming(false)
  }

  // ---- resize (bottom-right grip) ----
  const resizeRef = useRef<{
    px: number
    py: number
    w: number
    h: number
    zoom: number
  } | null>(null)

  const onResizeDown = (e: React.PointerEvent) => {
    if (el.locked) return
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    select()
    beginHistory()
    const zoom = selectActive(useStore.getState()).camera.zoom
    resizeRef.current = { px: e.clientX, py: e.clientY, w: el.w, h: el.h, zoom }
  }
  const onResizeMove = (e: React.PointerEvent) => {
    const r = resizeRef.current
    if (!r) return
    const dw = (e.clientX - r.px) / r.zoom
    const dh = (e.clientY - r.py) / r.zoom
    let w = Math.max(MIN_W, r.w + dw)
    let h = Math.max(MIN_H, r.h + dh)
    // snap the dragged right/bottom edges to other elements' edges/centers
    const st = useStore.getState()
    const others = selectActive(st)
      .elements.filter((o) => o.id !== el.id)
      .map(elementBounds)
    const { xs, ys } = edgeLines(others)
    const tol = 6 / r.zoom
    const sx = snapValue(el.x + w, xs, tol)
    const sy = snapValue(el.y + h, ys, tol)
    if (sx != null) w = Math.max(MIN_W, sx - el.x)
    if (sy != null) h = Math.max(MIN_H, sy - el.y)
    st.setSnapGuides({ vx: sx, hy: sy })
    mutateElement(el.id, (wd) => {
      const ww = wd as WidgetElement
      ww.w = w
      ww.h = h
    })
  }
  const onResizeUp = (e: React.PointerEvent) => {
    resizeRef.current = null
    useStore.getState().setSnapGuides(null)
    try {
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      className={`widget${selected ? ' widget--selected' : ''}${
        active ? ' widget--active' : ''
      }`}
      style={
        {
          left: el.x,
          top: el.y,
          width: el.w,
          height: el.h,
          '--k': accent,
        } as React.CSSProperties
      }
    >
      <div className="widget__bar" onPointerDown={grab}>
        <span className="widget__icon">
          <Icon />
        </span>
        {isTerminal && <AgentDot id={sessionId} />}
        {renaming ? (
          <input
            ref={titleRef}
            className="widget__title"
            style={{ background: 'transparent', border: 'none' }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') commitName()
              if (e.key === 'Escape') {
                setName(el.title)
                setRenaming(false)
              }
            }}
          />
        ) : (
          <span
            className="widget__title"
            onDoubleClick={(e) => {
              e.stopPropagation()
              setRenaming(true)
            }}
          >
            {el.title}
          </span>
        )}
        {!renaming && folder && (
          <span className="widget__cwd" title={el.cwd}>
            {folder}
          </span>
        )}
        {el.kind === 'agent' && (
          <span className={`agent-harness agent-harness--${el.harness === 'pi' ? 'pi' : 'claude'}`}>
            {el.harness === 'pi' ? 'pi' : 'claude'}
          </span>
        )}
        {el.kind === 'agent' && <AgentMeter id={sessionId} />}
        <span className="widget__bar-spacer" />
        <div className="widget__actions">
          {el.kind === 'agent' && (
            <button
              className="widget__btn"
              title="Agent settings"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() =>
                openAgentWizard({ x: el.x + el.w / 2, y: el.y + el.h / 2, editId: el.id })
              }
            >
              <IconSettings />
            </button>
          )}
          <button
            className={`widget__btn${el.locked ? ' widget__btn--on' : ''}`}
            title={el.locked ? 'Unlock' : 'Lock position'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              beginHistory()
              mutateElement(el.id, (w) => {
                w.locked = !w.locked
              })
            }}
          >
            <IconLock />
          </button>
          <button
            className="widget__btn widget__btn--danger"
            title="Close widget"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              beginHistory()
              removeElements([el.id])
            }}
          >
            <IconClose />
          </button>
        </div>
      </div>

      <div
        ref={dropBodyRef}
        data-ccanvas-file-drop-target={isTerminal ? 'true' : undefined}
        className={`widget__body${dropActive ? ' widget__body--drop-active' : ''}`}
        style={
          isLive || isNote
            ? { pointerEvents: tool === 'select' ? 'auto' : 'none' }
            : undefined
        }
        onPointerDownCapture={isLive ? onLiveBodyCapture : undefined}
        onPointerDown={isLive ? onLiveBodyDown : undefined}
        onDragOverCapture={isTerminal ? onBodyDragOver : undefined}
        onDragLeaveCapture={isTerminal ? onBodyDragLeave : undefined}
        onDropCapture={isTerminal ? onBodyDrop : undefined}
      >
        <WidgetErrorBoundary>
          {el.kind === 'note' && <NoteBody el={el} active={active} />}
          {el.kind === 'web' && <WebBody el={el} active={active} />}
          {el.kind === 'video' && <VideoBody el={el} active={active} />}
          {el.kind === 'mediainfo' && <MediaInfoBody el={el} />}
          {el.kind === 'claude' && <KnowledgeGraphBody el={el} />}
          {isTerminal && (
            <TerminalBody
              workspaceId={workspaceId}
              el={el}
              active={active}
              visible={visible}
            />
          )}
          {el.kind === 'files' && <FilesBody el={el} />}
          {el.kind === 'diff' && <DiffBody el={el} />}
          {el.kind === 'editor' && <EditorBody el={el} active={active} />}
          {el.kind === 'doc' && <DocBody el={el} />}
          {el.kind === 'log' && <LogBody el={el} />}
          {el.kind === 'pr' && <PrBody el={el} />}
          {el.kind === 'issues' && <IssuesBody el={el} />}
          {el.kind === 'runs' && <RunsBody el={el} />}
          {el.kind === 'runner' && <RunnerBody el={el} />}
          {el.kind === 'sql' && <SqlBody el={el} active={active} />}
          {el.kind === 'data' && <DataBody el={el} />}
          {el.kind === 'plot' && <PlotBody el={el} />}
          {el.kind === 'transcript' && <TranscriptBody el={el} />}
        </WidgetErrorBoundary>

        {shielded && (
          <div
            className="widget__shield"
            onPointerDown={grab}
            onDoubleClick={(e) => {
              e.stopPropagation()
              select()
              setActiveWidget(el.id)
            }}
          >
            <span className="widget__shield-hint">double-click to interact</span>
          </div>
        )}
      </div>

      {!el.locked && (
        <div
          className="widget__resize"
          title="Resize"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
        />
      )}
    </div>
  )
}

// Activity dot for terminal/agent widgets: reflects whether the session is
// idle, streaming output, or appears to be waiting on a prompt.
function AgentDot({ id }: { id: string }) {
  const status = useAgents((s) => s.status[id])
  if (!status || status === 'off') return null
  const title =
    status === 'working'
      ? 'working…'
      : status === 'waiting'
        ? 'waiting for input'
        : status === 'connecting'
          ? 'connecting…'
          : 'idle'
  return <span className={`agent-dot agent-dot--${status}`} title={title} />
}

// Compact activity meter: settled runs / model turns · active time · context · estimated cost.
function fmtMeter(m: AgentMetrics, piUsage?: PiSessionUsage): string {
  const context = piUsage?.context
  const time =
    m.activeMs >= 60000
      ? `${Math.round(m.activeMs / 60000)}m`
      : `${Math.round(m.activeMs / 1000)}s`
  const parts = [`${m.runs}r/${m.turns}t`, time]
  if (m.failedRuns || m.abortedRuns) parts.push(`!${m.failedRuns + m.abortedRuns}`)
  if (context) parts.push(context.percent == null ? 'ctx ?' : `ctx ${Math.round(context.percent)}%`)
  if (m.costUsd != null) parts.push(`${piUsage ? '~' : ''}$${m.costUsd.toFixed(2)}`)
  return parts.join(' · ')
}
function AgentMeter({ id }: { id: string }) {
  const m = useAgents((s) => s.metrics[id])
  const piUsage = useAgents((s) => s.piUsage[id])
  if (!m || (m.runs === 0 && m.turns === 0 && m.costUsd == null && !piUsage)) return null
  const title = piUsage
    ? 'settled runs / model turns · active time · current context (unknown after compaction until Pi reports it) · Pi-estimated session cost'
    : 'settled runs / model turns · active time · failures · Claude-reported cost'
  return (
    <span className="widget__meter" title={title}>
      {fmtMeter(m, piUsage)}
    </span>
  )
}
