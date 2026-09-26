import { useEffect, useMemo, useRef, useState } from 'react'
import { getUsage, type Usage } from '../lib/backend'
import { storageKey } from '../lib/fork'
import { aggregatePiUsage, useAgents } from '../lib/agents'

// per-window token budget (tokens). 0 = no bar, just show usage + reset.
const LIMIT_KEY = storageKey('usageLimit')

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M'
  if (n >= 1_000) return Math.round(n / 1000) + 'K'
  return String(n)
}
function fmtCountdown(resetMs: number | null): string {
  if (!resetMs) return ''
  const ms = resetMs - Date.now()
  if (ms <= 0) return 'now'
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}
function fmtTime(resetMs: number): string {
  return new Date(resetMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function UsagePill() {
  const [u, setU] = useState<Usage | null>(null)
  const [open, setOpen] = useState(false)
  const [limit, setLimit] = useState<number>(() => Number(localStorage.getItem(LIMIT_KEY)) || 0)
  const [, tick] = useState(0) // re-render to refresh the countdown
  const ref = useRef<HTMLDivElement>(null)
  const piUsage = useAgents((s) => s.piUsage)
  const pi = useMemo(() => aggregatePiUsage(piUsage), [piUsage])

  useEffect(() => {
    let alive = true
    const poll = async () => {
      const r = await getUsage()
      if (alive) setU(r)
    }
    poll()
    const pollId = setInterval(poll, 45_000)
    const tickId = setInterval(() => tick((n) => n + 1), 30_000)
    return () => {
      alive = false
      clearInterval(pollId)
      clearInterval(tickId)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const claude = u?.hasData ? u : null
  if (!claude && pi.sessions === 0) return null

  const hasLimit = !!claude && limit > 0
  const pct = claude && hasLimit ? Math.min(100, (claude.activeTokens / limit) * 100) : 0
  const hot = hasLimit && pct >= 85

  return (
    <div className="usage" ref={ref}>
      <button
        className={`tb-btn usage__pill${hot ? ' usage__pill--hot' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={
          pi.sessions
            ? 'Attached Pi sessions — Pi-estimated cost and tokens; not an account quota'
            : hasLimit
              ? 'Claude Code (legacy) — % of your configured 5h window budget'
              : 'Claude Code (legacy) usage estimate'
        }
      >
        {pi.sessions > 0 ? (
          <span className="usage__num">π ~${pi.costUsd.toFixed(2)}</span>
        ) : claude ? (
          <>
            {hasLimit && (
              <span className="usage__bar">
                <span className="usage__bar-fill" style={{ width: pct + '%' }} />
              </span>
            )}
            <span className="usage__num">
              {hasLimit ? `${Math.round(pct)}%` : fmtTokens(claude.activeTokens)}
            </span>
            {claude.resetMs && <span className="usage__reset">· {fmtCountdown(claude.resetMs)}</span>}
          </>
        ) : null}
      </button>

      {open && (
        <div className="usage__pop">
          {pi.sessions > 0 && (
            <>
              <div className="usage__title">Attached Pi sessions</div>
              <div className="usage__row">
                <span>Sessions</span>
                <b>{pi.sessions}</b>
              </div>
              <div className="usage__row">
                <span>Tokens</span>
                <b>{fmtTokens(pi.tokens)} tok</b>
              </div>
              <div className="usage__row">
                <span>Estimated cost</span>
                <b>~${pi.costUsd.toFixed(2)}</b>
              </div>
              {pi.unknownContext > 0 && (
                <div className="usage__row">
                  <span>Context unknown</span>
                  <b>{pi.unknownContext}</b>
                </div>
              )}
              <div className="usage__hint">
                Pi session totals for agents attached in this app, counted once per
                session. Costs are Pi model-price estimates, not bills or account
                limits. Pi has no ccanvas-managed reset window.
              </div>
            </>
          )}
          {pi.sessions > 0 && claude && <div className="usage__sep" />}
          {claude && (
            <>
              <div className="usage__title">Claude Code (legacy)</div>
              {hasLimit && (
                <div className="usage__row">
                  <span>Window used</span>
                  <b>{Math.round(pct)}%</b>
                </div>
              )}
              <div className="usage__row">
                <span>Estimated 5h window</span>
                <b>
                  {fmtTokens(claude.activeTokens)}
                  {hasLimit ? ` / ${fmtTokens(limit)}` : ''} tok
                </b>
              </div>
              {claude.resetMs && (
                <div className="usage__row">
                  <span>Estimated reset</span>
                  <b>
                    {fmtTime(claude.resetMs)} · {fmtCountdown(claude.resetMs)}
                  </b>
                </div>
              )}
              <div className="usage__row">
                <span>Last 24h</span>
                <b>{fmtTokens(claude.dayTokens)} tok</b>
              </div>
              <div className="usage__sep" />
              <label className="usage__row usage__limit">
                <span>Window limit</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={limit ? Math.round(limit / 1_000_000) : ''}
                  placeholder="off"
                  onChange={(e) => {
                    const tok = Math.max(0, Number(e.target.value) || 0) * 1_000_000
                    setLimit(tok)
                    if (tok) localStorage.setItem(LIMIT_KEY, String(tok))
                    else localStorage.removeItem(LIMIT_KEY)
                  }}
                />
                <span className="usage__unit">M</span>
              </label>
              <div className="usage__hint">
                Estimated from Claude Code local session logs. Set a per-window
                budget to show <b>% used</b>.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
