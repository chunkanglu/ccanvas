import type { CanvasElement, CcnvsFile, CcnvsFileV2, Prompt, Template, Workspace } from './types'
import { CCNVS_VERSION, DEFAULT_CAMERA } from './types'
import { newId } from './id'

import { storageKey } from './fork'

const SESSION_KEY = storageKey('session:v2')
const LEGACY_SESSION_KEY = storageKey('session:v1')
const TEMPLATES_KEY = storageKey('templates:v2')
const LEGACY_TEMPLATES_KEY = storageKey('templates:v1')
const PROMPTS_KEY = storageKey('prompts:v1')

// File System Access API handles are not serializable; keep them in memory
// keyed by workspace id so "Save" can write back to the same file.
const handles = new Map<string, FileSystemFileHandle>()

export const hasFsAccess = () =>
  typeof (window as any).showOpenFilePicker === 'function'

function normalizeElements(elements: unknown): CanvasElement[] {
  if (!Array.isArray(elements)) return []
  return elements.map((element) => {
    if (
      element && typeof element === 'object'
      && (element as CanvasElement).type === 'widget'
      && (element as CanvasElement & { kind?: string }).kind === 'agent'
    ) {
      const agent = element as CanvasElement & { harness?: unknown }
      // Fail closed to the existing Claude behavior. A typo must never opt an
      // old canvas into a different executable or permission model.
      const harness = agent.harness === 'pi' ? 'pi' : 'claude'
      return { ...agent, harness } as CanvasElement
    }
    return element as CanvasElement
  })
}

function normalizeWorkspace(ws: Workspace): Workspace {
  return { ...ws, elements: normalizeElements(ws.elements) }
}

function normalizeTemplate(template: Template): Template {
  return {
    ...template,
    widgets: Array.isArray(template.widgets)
      ? template.widgets.map(widget => widget.kind === 'agent'
        ? { ...widget, harness: widget.harness === 'pi' ? 'pi' : 'claude' }
        : widget)
      : [],
  }
}

export function toFile(ws: Workspace): CcnvsFileV2 {
  return {
    format: 'ccnvs',
    version: CCNVS_VERSION,
    name: ws.name,
    camera: ws.camera,
    elements: normalizeElements(ws.elements),
  }
}

export function fromFile(data: CcnvsFile, name: string): Workspace {
  if (!data || data.format !== 'ccnvs' || (data.version !== 1 && data.version !== CCNVS_VERSION)) {
    throw new Error('Unsupported ccanvas workspace format or version')
  }
  return {
    id: newId(),
    name: data.name || name,
    elements: normalizeElements(data.elements),
    camera: data.camera ?? { ...DEFAULT_CAMERA },
    createdAt: Date.now(),
    dirty: false,
  }
}

function serialize(ws: Workspace): string {
  return JSON.stringify(toFile(ws), null, 2)
}

// ---------- open ----------

export async function openWorkspace(): Promise<Workspace | null> {
  if (hasFsAccess()) {
    try {
      const [handle] = await (window as any).showOpenFilePicker({
        types: [
          { description: 'ccanvas workspace', accept: { 'application/json': ['.ccnvs'] } },
        ],
      })
      const file = await handle.getFile()
      const text = await file.text()
      const ws = fromFile(JSON.parse(text), file.name.replace(/\.ccnvs$/, ''))
      handles.set(ws.id, handle)
      return ws
    } catch (e) {
      // user cancelled
      return null
    }
  }
  // fallback: <input type=file>
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.ccnvs,application/json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      const text = await file.text()
      try {
        resolve(fromFile(JSON.parse(text), file.name.replace(/\.ccnvs$/, '')))
      } catch {
        resolve(null)
      }
    }
    input.click()
  })
}

// ---------- save ----------

export async function saveWorkspace(
  ws: Workspace,
  forceDialog = false,
): Promise<boolean> {
  const text = serialize(ws)

  if (hasFsAccess()) {
    try {
      let handle = handles.get(ws.id)
      if (!handle || forceDialog) {
        handle = await (window as any).showSaveFilePicker({
          suggestedName: `${ws.name}.ccnvs`,
          types: [
            {
              description: 'ccanvas workspace',
              accept: { 'application/json': ['.ccnvs'] },
            },
          ],
        })
        if (handle) handles.set(ws.id, handle)
      }
      if (!handle) return false
      const writable = await handle.createWritable()
      await writable.write(text)
      await writable.close()
      return true
    } catch {
      return false
    }
  }

  // fallback: trigger a download
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${ws.name}.ccnvs`
  a.click()
  URL.revokeObjectURL(url)
  return true
}

// ---------- session autosave (localStorage) ----------

type SessionShape = {
  tabs: Workspace[]
  activeTabId: string | null
}

export function saveSession(s: SessionShape) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      ...s,
      tabs: s.tabs.map(normalizeWorkspace),
    }))
  } catch {
    /* quota / private mode: ignore */
  }
}

export function loadSession(): SessionShape | null {
  try {
    const current = localStorage.getItem(SESSION_KEY)
    const legacy = current ? null : localStorage.getItem(LEGACY_SESSION_KEY)
    const raw = current ?? legacy
    if (!raw) return null
    const parsed = JSON.parse(raw) as SessionShape
    if (!parsed.tabs?.length) return null
    const normalized = { ...parsed, tabs: parsed.tabs.map(normalizeWorkspace) }
    if (legacy) saveSession(normalized)
    return normalized
  } catch {
    return null
  }
}

// ---------- widget-layout templates (localStorage) ----------

export function loadTemplates(): Template[] {
  try {
    const current = localStorage.getItem(TEMPLATES_KEY)
    const legacy = current ? null : localStorage.getItem(LEGACY_TEMPLATES_KEY)
    const raw = current ?? legacy
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const normalized = (parsed as Template[]).map(normalizeTemplate)
    if (legacy) saveTemplates(normalized)
    return normalized
  } catch {
    return []
  }
}

export function saveTemplates(templates: Template[]) {
  try {
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates.map(normalizeTemplate)))
  } catch {
    /* quota / private mode: ignore */
  }
}

// ---------- prompt library (localStorage) ----------

export function loadPrompts(): Prompt[] {
  try {
    const raw = localStorage.getItem(PROMPTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Prompt[]) : []
  } catch {
    return []
  }
}

export function savePrompts(prompts: Prompt[]) {
  try {
    localStorage.setItem(PROMPTS_KEY, JSON.stringify(prompts))
  } catch {
    /* quota / private mode: ignore */
  }
}
