import { useState } from 'react'
import { useStore, selectActive } from '../store/workspace'
import type { AgentWizardCtx } from '../store/workspace'
import { AGENT_COLORS, claudeColorName } from '../lib/types'
import type { AgentHarness, AgentThinkingLevel, WidgetElement } from '../lib/types'
import { agentRuntimeId, renameSession, sendTo, isLive } from '../lib/agents'
import { IconAgent } from './icons'

const MODELS = ['default', 'opus', 'sonnet', 'haiku']
type ThinkingChoice = 'default' | AgentThinkingLevel
const THINKING: ThinkingChoice[] = ['default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const DEFAULT_COLOR = AGENT_COLORS[0].hex

// Modal shown when creating (or editing) an agent — set its name, colour,
// model, permission mode, and an optional first prompt before it launches.
export function AgentWizard() {
  const ctx = useStore((s) => s.agentWizard)
  if (!ctx) return null
  // key on the target so the form resets each time it opens
  return <Wizard key={ctx.editId ?? `${ctx.x},${ctx.y}`} ctx={ctx} />
}

function Wizard({ ctx }: { ctx: AgentWizardCtx }) {
  const close = useStore((s) => s.closeAgentWizard)
  const spawnWidget = useStore((s) => s.spawnWidget)
  const mutateElement = useStore((s) => s.mutateElement)
  const beginHistory = useStore((s) => s.beginHistory)
  const ws = useStore(selectActive)

  const existing = ctx.editId
    ? (ws.elements.find((e) => e.id === ctx.editId) as WidgetElement | undefined)
    : undefined
  const editing = !!existing

  const [harness, setHarness] = useState<AgentHarness>(existing?.harness ?? ctx.harness ?? 'claude')
  const [name, setName] = useState(existing?.title ?? ctx.title ?? '')
  const [color, setColor] = useState(existing?.color ?? DEFAULT_COLOR)
  const [provider, setProvider] = useState(existing?.provider ?? '')
  const [model, setModel] = useState(existing?.model ?? ctx.model ?? (harness === 'claude' ? 'default' : ''))
  const [thinking, setThinking] = useState<ThinkingChoice>(existing?.thinkingLevel ?? 'default')
  const [skip, setSkip] = useState(existing?.skipPermissions ?? false)
  const [prompt, setPrompt] = useState(
    (existing?.harness === 'pi' ? existing.promptDraft : existing?.agentPrompt)
      ?? ctx.agentPrompt
      ?? '',
  )

  const folder = ctx.worktree
    ? `worktree · ${ctx.worktree}`
    : (ctx.cwd ?? ws.dir)?.replace(/[\\/]+$/, '').split(/[\\/]/).pop()

  const submit = () => {
    const title = name.trim() || `${harness} agent`
    const cleanModel = model === 'default' || !model.trim() ? undefined : model.trim()
    if (editing && existing) {
      beginHistory()
      mutateElement(existing.id, (w) => {
        const a = w as WidgetElement
        a.title = title
        a.color = color
        a.harness = harness
        a.model = cleanModel
        if (harness === 'pi') {
          a.provider = provider.trim() || undefined
          a.thinkingLevel = thinking === 'default' ? undefined : thinking
          a.skipPermissions = false
          a.agentPrompt = undefined
          a.promptDraft = prompt || undefined
        } else {
          a.provider = undefined
          a.thinkingLevel = undefined
          a.skipPermissions = skip
          a.agentPrompt = prompt.trim() || undefined
        }
      })
      const runtimeId = agentRuntimeId(ws.id, existing)
      if (isLive(runtimeId)) {
        if (title !== existing.title) renameSession(runtimeId, title)
        if (harness === 'claude') sendTo(runtimeId, `/color ${claudeColorName(color)}\r`)
      }
    } else {
      spawnWidget('agent', ctx.x, ctx.y, {
        title,
        color,
        harness,
        provider: harness === 'pi' ? provider.trim() || undefined : undefined,
        model: cleanModel,
        thinkingLevel: harness === 'pi' && thinking !== 'default' ? thinking : undefined,
        skipPermissions: harness === 'claude' ? skip : false,
        agentPrompt: harness === 'claude' ? prompt.trim() || undefined : undefined,
        promptDraft: harness === 'pi' ? prompt || undefined : undefined,
        ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
        ...(ctx.worktree ? { worktree: ctx.worktree } : {}),
      })
    }
    close()
  }

  return (
    <div className="wiz-backdrop" onPointerDown={close}>
      <div
        className="wiz"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') close()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
        }}
      >
        <div className="wiz__head">
          <span className="wiz__icon" style={{ color }}>
            <IconAgent />
          </span>
          <span className="wiz__title">{editing ? 'Edit agent' : 'New agent'}</span>
          {folder && <span className="wiz__folder">{folder}</span>}
        </div>

        <label className="wiz__label">Harness</label>
        <div className="wiz__seg">
          {(['claude', 'pi'] as AgentHarness[]).map((value) => (
            <button
              key={value}
              className={`wiz__seg-btn${harness === value ? ' wiz__seg-btn--active' : ''}`}
              disabled={editing}
              title={editing ? 'Harness cannot change after creation' : undefined}
              onClick={() => {
                setHarness(value)
                setModel(value === 'claude' ? 'default' : '')
                setSkip(false)
              }}
            >
              {value}
            </button>
          ))}
        </div>

        <label className="wiz__label">Name</label>
        <input
          className="wiz__input"
          autoFocus
          placeholder={`${harness} agent`}
          value={name}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />

        <label className="wiz__label">Color</label>
        <div className="wiz__swatches">
          {AGENT_COLORS.map((c) => (
            <button
              key={c.name}
              className={`wiz__swatch${color === c.hex ? ' wiz__swatch--active' : ''}`}
              style={{ background: c.hex }}
              title={c.name}
              onClick={() => setColor(c.hex)}
            />
          ))}
        </div>

        {harness === 'claude' ? (
          <>
            <label className="wiz__label">Model</label>
            <div className="wiz__seg">
              {MODELS.map((m) => (
                <button
                  key={m}
                  className={`wiz__seg-btn${model === m ? ' wiz__seg-btn--active' : ''}`}
                  onClick={() => setModel(m)}
                >
                  {m}
                </button>
              ))}
            </div>

            <label className="wiz__check">
              <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
              skip permission prompts <code>--dangerously-skip-permissions</code>
            </label>

            <label className="wiz__label">Initial prompt (optional)</label>
            <textarea
              className="wiz__textarea"
              placeholder="What should this agent start working on?"
              value={prompt}
              spellCheck={false}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </>
        ) : (
          <>
            <label className="wiz__label">Provider (optional)</label>
            <input
              className="wiz__input"
              placeholder="anthropic"
              value={provider}
              disabled={editing}
              spellCheck={false}
              onChange={(e) => setProvider(e.target.value)}
            />
            <label className="wiz__label">Model (optional)</label>
            <input
              className="wiz__input"
              placeholder="use Pi default"
              value={model}
              disabled={editing}
              spellCheck={false}
              onChange={(e) => setModel(e.target.value)}
            />
            <label className="wiz__label">Thinking</label>
            <div className="wiz__seg">
              {THINKING.map((level) => (
                <button
                  key={level}
                  className={`wiz__seg-btn${thinking === level ? ' wiz__seg-btn--active' : ''}`}
                  disabled={editing}
                  onClick={() => setThinking(level)}
                >
                  {level}
                </button>
              ))}
            </div>
            {editing && <span className="wiz__hint">Use the agent's live settings panel, or recreate it to change launch defaults.</span>}
            <label className="wiz__label">Initial draft (optional)</label>
            <textarea
              className="wiz__textarea"
              placeholder="Review and send this from the Pi composer"
              value={prompt}
              spellCheck={false}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </>
        )}

        <div className="wiz__actions">
          <button className="wiz__btn" onClick={close}>
            Cancel
          </button>
          <button className="wiz__btn wiz__btn--primary" onClick={submit}>
            {editing ? 'Save' : 'Create agent'}
          </button>
        </div>
        <span className="wiz__hint">⌘↵ to {editing ? 'save' : 'create'} · esc to cancel</span>
      </div>
    </div>
  )
}
