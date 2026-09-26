import { useMemo, useState } from 'react'
import { useStore } from '../store/workspace'
import { agentRuntimeId, deliverPrompt, useAgents } from '../lib/agents'
import type { WidgetElement, Workspace } from '../lib/types'
import { IconClose, IconBroadcast, IconTrack } from './icons'
import '../styles/agent-tools.css'

const CHROME_H = 82

type Row = { agent: WidgetElement; tab: Workspace }
const rowRuntimeId = (row: Row) => agentRuntimeId(row.tab.id, row.agent)

// Mission-control list of every agent across all tabs: status, cost/turns, last
// line, click-to-focus, and a composer that sends to one agent or broadcasts to
// all. The spatial canvas is great for layout but poor at "is anything stuck?" —
// this is the at-scale answer.
export function Roster() {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const trackingId = useStore((s) => s.trackingAgentId)
  const trackingTabId = useStore((s) => s.trackingAgentTabId)
  const switchTab = useStore((s) => s.switchTab)
  const setCamera = useStore((s) => s.setCamera)
  const setSelection = useStore((s) => s.setSelection)
  const setActiveWidget = useStore((s) => s.setActiveWidget)
  const bringToFront = useStore((s) => s.bringToFront)
  const startTrackingAgent = useStore((s) => s.startTrackingAgent)
  const stopTrackingAgent = useStore((s) => s.stopTrackingAgent)
  const setOpenPanel = useStore((s) => s.setOpenPanel)

  const status = useAgents((s) => s.status)
  const metrics = useAgents((s) => s.metrics)
  const lastLine = useAgents((s) => s.lastLine)

  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [deliveryStatus, setDeliveryStatus] = useState<string>()
  const [retryIds, setRetryIds] = useState<string[]>()
  const [target, setTarget] = useState<string | null>(null) // agent id, or null = all

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const tab of tabs)
      for (const e of tab.elements)
        if (e.type === 'widget' && e.kind === 'agent') out.push({ agent: e, tab })
    return out
  }, [tabs])

  const focus = (row: Row) => {
    if (activeTabId !== row.tab.id) switchTab(row.tab.id)
    const cam = row.tab.camera
    const cx = row.agent.x + row.agent.w / 2
    const cy = row.agent.y + row.agent.h / 2
    setCamera({
      zoom: cam.zoom,
      x: window.innerWidth / 2 - cx * cam.zoom,
      y: (window.innerHeight - CHROME_H) / 2 - cy * cam.zoom,
    })
    setSelection([row.agent.id])
    setActiveWidget(row.agent.id)
    bringToFront([row.agent.id])
    setTarget(rowRuntimeId(row))
    setRetryIds(undefined)
  }

  const send = async () => {
    const body = text.trim()
    if (!body || sending) return
    const ids = retryIds ?? (target ? [target] : rows.map(rowRuntimeId))
    if (!ids.length) return
    setSending(true)
    setDeliveryStatus('sending…')
    try {
      const results = await Promise.all(ids.map(id => deliverPrompt(id, body)))
      const accepted = results.filter(result => result.status === 'accepted')
      const failed = results.filter(result => result.status !== 'accepted')
      if (!failed.length) {
        setText('')
        setRetryIds(undefined)
        setDeliveryStatus(`${accepted.length}/${results.length} accepted`)
      } else {
        const detail = failed.map(result => {
          const row = rows.find(candidate => rowRuntimeId(candidate) === result.id)
          return `${row?.agent.title ?? result.id}: ${result.error ?? result.status}`
        }).join(' · ')
        setRetryIds(failed.map(result => result.id))
        setDeliveryStatus(`${accepted.length}/${results.length} accepted · retry: ${detail}`)
      }
    } finally {
      setSending(false)
    }
  }

  const targetRow = target ? rows.find((row) => rowRuntimeId(row) === target) : undefined
  const targetLabel = targetRow?.agent.title ?? 'all agents'

  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__title">Agents</span>
        <span className="panel__badge">{rows.length}</span>
        <span className="panel__spacer" />
        <button className="panel__x" title="Close" onClick={() => setOpenPanel(null)}>
          <IconClose size={14} />
        </button>
      </div>

      <div className="panel__body">
        {rows.length === 0 && (
          <div className="panel__empty">No agents yet. Spawn one with the “a” tool or ⌘K.</div>
        )}
        {rows.map((row) => {
          const runtimeId = rowRuntimeId(row)
          const st = status[runtimeId] ?? 'off'
          const m = metrics[runtimeId]
          const ll = lastLine[runtimeId]
          const tracking = trackingId === row.agent.id && trackingTabId === row.tab.id
          return (
            <div
              key={runtimeId}
              className={`roster__row${target === runtimeId ? ' roster__row--target' : ''}`}
              onClick={() => focus(row)}
            >
              <span className={`agent-dot agent-dot--${st}`} title={st} />
              <div className="roster__main">
                <div className="roster__top">
                  <span className="roster__name">{row.agent.title}</span>
                  <span className={`agent-harness agent-harness--${row.agent.harness === 'pi' ? 'pi' : 'claude'}`}>
                    {row.agent.harness === 'pi' ? 'pi' : 'claude'}
                  </span>
                  {row.tab.id !== activeTabId && (
                    <span className="roster__tab">{row.tab.name}</span>
                  )}
                  {m && (m.runs > 0 || m.turns > 0 || m.costUsd != null) && (
                    <span
                      className="roster__meter"
                      title={`${m.runs} settled runs · ${m.turns} model turns · ${m.failedRuns} failed · ${m.abortedRuns} aborted${row.agent.harness === 'pi' ? ' · Pi-estimated session cost' : ''}`}
                    >
                      {m.runs}r/{m.turns}t{m.costUsd != null ? ` · ${row.agent.harness === 'pi' ? '~' : ''}$${m.costUsd.toFixed(2)}` : ''}
                    </span>
                  )}
                </div>
                {ll && <div className="roster__last">{ll}</div>}
              </div>
              <button
                className={`roster__track${tracking ? ' roster__track--on' : ''}`}
                title={tracking ? 'Stop tracking camera' : 'Track this agent (orbit successful file tools)'}
                onClick={(e) => {
                  e.stopPropagation()
                  if (tracking) stopTrackingAgent(false)
                  else void startTrackingAgent(row.agent.id, row.tab.id)
                }}
              >
                <IconTrack size={15} />
              </button>
            </div>
          )
        })}
      </div>

      <div className="panel__composer">
        <button
          className="composer__target"
          title="Toggle between the focused agent and broadcasting to all"
          onClick={() => {
            setTarget(null)
            setRetryIds(undefined)
          }}
        >
          {target ? '→ ' : <IconBroadcast size={14} />}
          <span className="composer__target-name">
            {retryIds ? `${retryIds.length} failed target${retryIds.length === 1 ? '' : 's'}` : targetLabel}
          </span>
        </button>
        <textarea
          className="composer__input"
          placeholder={target ? 'Message this agent…' : 'Broadcast to all agents…'}
          value={text}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value)
            setDeliveryStatus(undefined)
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {deliveryStatus && <span className="composer__result" title={deliveryStatus}>{deliveryStatus}</span>}
        <button
          className="composer__send"
          disabled={!text.trim() || sending}
          onClick={() => { void send() }}
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  )
}
