import { useState } from 'react'
import { useStore, selectActive } from '../store/workspace'
import { agentRuntimeId, sendPrompt, isLive } from '../lib/agents'
import type { WidgetElement } from '../lib/types'
import { IconClose, IconPlus } from './icons'
import '../styles/agent-tools.css'

// Reusable prompt snippets. Insert one into the focused agent (pasted, not
// auto-submitted, so it can be tweaked), drag one onto any agent, or manage the
// library. Stored in localStorage, like widget-layout templates.

/** The agent/terminal a library insert should target: the active one, else the
 *  first selected agent. Returns null if nothing suitable is focused. */
function targetAgent(): { widgetId: string; runtimeId: string } | null {
  const s = useStore.getState()
  const ws = selectActive(s)
  const byId = new Map(ws.elements.map((e) => [e.id, e]))
  const isInjectable = (id?: string | null) => {
    if (!id) return false
    const el = byId.get(id)
    return !!el && el.type === 'widget' && (el.kind === 'agent' || el.kind === 'terminal')
  }
  const widgetId = isInjectable(s.activeWidgetId)
    ? s.activeWidgetId!
    : s.selection.find((id) => isInjectable(id))
  if (!widgetId) return null
  const el = byId.get(widgetId)!
  return { widgetId, runtimeId: agentRuntimeId(ws.id, el as WidgetElement) }
}

export function PromptLibrary() {
  const prompts = useStore((s) => s.prompts)
  const savePrompt = useStore((s) => s.savePrompt)
  const deletePrompt = useStore((s) => s.deletePrompt)
  const setActiveWidget = useStore((s) => s.setActiveWidget)
  const setOpenPanel = useStore((s) => s.setOpenPanel)

  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [note, setNote] = useState('')

  const insert = (promptText: string) => {
    const target = targetAgent()
    if (!target || !isLive(target.runtimeId)) {
      setNote('Focus a running agent first, or drag the prompt onto one.')
      setTimeout(() => setNote(''), 2600)
      return
    }
    sendPrompt(target.runtimeId, promptText, false)
    setActiveWidget(target.widgetId)
    setOpenPanel(null)
  }

  const add = () => {
    if (!text.trim()) return
    savePrompt(name || text.trim().slice(0, 28), text)
    setName('')
    setText('')
    setAdding(false)
  }

  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__title">Prompts</span>
        <span className="panel__badge">{prompts.length}</span>
        <span className="panel__spacer" />
        <button className="panel__x" title="New prompt" onClick={() => setAdding((a) => !a)}>
          <IconPlus size={14} />
        </button>
        <button className="panel__x" title="Close" onClick={() => setOpenPanel(null)}>
          <IconClose size={14} />
        </button>
      </div>

      {adding && (
        <div className="prompt__editor">
          <input
            className="prompt__name"
            placeholder="Name"
            value={name}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <textarea
            className="prompt__text"
            placeholder="Prompt text — e.g. “Review this diff for correctness bugs and summarize the risky parts.”"
            value={text}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <div className="prompt__editor-actions">
            <button className="prompt__cancel" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button className="prompt__save" disabled={!text.trim()} onClick={add}>
              Save
            </button>
          </div>
        </div>
      )}

      <div className="panel__body">
        {note && <div className="panel__note">{note}</div>}
        {prompts.length === 0 && !adding && (
          <div className="panel__empty">
            No saved prompts. Click ＋ to add reusable snippets you can drop into any agent.
          </div>
        )}
        {prompts.map((p) => (
          <div
            key={p.id}
            className="prompt__row"
            draggable
            title="Click to insert into the focused agent · drag onto any agent"
            onClick={() => insert(p.text)}
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-ccanvas-prompt', p.text)
              e.dataTransfer.setData('text/plain', p.text)
              e.dataTransfer.effectAllowed = 'copy'
            }}
          >
            <div className="prompt__row-main">
              <div className="prompt__row-name">{p.name}</div>
              <div className="prompt__row-preview">{p.text}</div>
            </div>
            <button
              className="prompt__del"
              title="Delete"
              onClick={(e) => {
                e.stopPropagation()
                deletePrompt(p.id)
              }}
            >
              <IconClose size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
