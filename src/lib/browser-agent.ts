import { invoke } from '@tauri-apps/api/core'
import type { CanvasElement, WidgetElement, Workspace } from './types'
import { navigatePortal, portalAction } from './portal'

// Host side of the `canvas_browser` Pi tool. A Pi agent may drive only web
// widgets the user connected to it with an arrow, addressed by browser name.
// Actions run inside the native WebKit portal through synchronous injected
// JavaScript, modeled on browser-use's snapshot → act-by-ref workflow.

export const BROWSER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

/** Canonical browser name; legacy widgets without one get a stable id-based name. */
export function browserNameOf(el: Pick<WidgetElement, 'id' | 'browserName'>): string {
  return el.browserName && BROWSER_NAME_RE.test(el.browserName)
    ? el.browserName
    : `browser-${el.id.replace(/[^a-z0-9]/gi, '').slice(0, 4).toLowerCase() || 'x'}`
}

export function normalizeBrowserName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
}

/** A unique name within the canvas, e.g. `browser`, `browser-2`. */
export function uniqueBrowserName(elements: CanvasElement[], base = 'browser', exceptId?: string): string {
  const taken = new Set(
    elements
      .filter((element): element is WidgetElement => element.type === 'widget' && element.kind === 'web' && element.id !== exceptId)
      .map(browserNameOf),
  )
  const clean = normalizeBrowserName(base) || 'browser'
  if (!taken.has(clean)) return clean
  for (let index = 2; ; index++) {
    const candidate = `${clean.slice(0, 28)}-${index}`
    if (!taken.has(candidate)) return candidate
  }
}

const isWeb = (element: CanvasElement | undefined): element is WidgetElement =>
  !!element && element.type === 'widget' && element.kind === 'web' && !element.path

/** Browsers an agent may drive: web widgets joined to it by an arrow, either direction. */
export function connectedBrowsers(workspace: Workspace, agentId: string): WidgetElement[] {
  const byId = new Map(workspace.elements.map(element => [element.id, element]))
  const out = new Map<string, WidgetElement>()
  for (const element of workspace.elements) {
    if (element.type !== 'arrow' || !element.from || !element.to) continue
    const other = element.from.id === agentId ? element.to.id : element.to.id === agentId ? element.from.id : null
    const target = other ? byId.get(other) : undefined
    if (isWeb(target)) out.set(target.id, target)
  }
  return [...out.values()]
}

/** Agents (by title) able to drive a browser, for the widget's indicator. */
export function agentsDriving(workspace: Workspace, browserId: string): WidgetElement[] {
  const byId = new Map(workspace.elements.map(element => [element.id, element]))
  const out = new Map<string, WidgetElement>()
  for (const element of workspace.elements) {
    if (element.type !== 'arrow' || !element.from || !element.to) continue
    const other = element.from.id === browserId ? element.to.id : element.to.id === browserId ? element.from.id : null
    const agent = other ? byId.get(other) : undefined
    if (agent?.type === 'widget' && agent.kind === 'agent' && agent.harness === 'pi') out.set(agent.id, agent)
  }
  return [...out.values()]
}

// ---------- portal registry (mounted native portals by canvas widget) ----------

const portals = new Map<string, string>()
const registryKey = (workspaceId: string, widgetId: string) => `${workspaceId}:${widgetId}`
export function registerPortal(workspaceId: string, widgetId: string, portalId: string): () => void {
  const key = registryKey(workspaceId, widgetId)
  portals.set(key, portalId)
  return () => { if (portals.get(key) === portalId) portals.delete(key) }
}
const portalFor = (workspaceId: string, widgetId: string) => portals.get(registryKey(workspaceId, widgetId))

export const BROWSER_ACTIVITY_EVENT = 'ccanvas:browser-activity'

// ---------- injected automation ----------

/**
 * Page-side helpers, installed once per document. Synchronous only: WebKit's
 * evaluateJavaScript does not await promises. Every command returns a JSON
 * object and never throws out of the wrapper, so the host always gets a reply.
 */
const AGENT_SOURCE = String.raw`
(function () {
  if (window.__ccanvasAgent && window.__ccanvasAgent.v === 1) return window.__ccanvasAgent;
  var SELECTOR = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=textbox],[role=combobox],[role=searchbox],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  var refs = new Map(); var next = 0;
  function clean(t) { return (t || '').replace(/\s+/g, ' ').trim(); }
  function clip(t, n) { t = clean(t); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
  function visible(el) {
    var r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false;
    var s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  }
  function roleOf(el) {
    var explicit = el.getAttribute('role'); if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['checkbox', 'radio'].indexOf(type) >= 0) return type;
      if (['button', 'submit', 'reset', 'image'].indexOf(type) >= 0) return 'button';
      return type === 'search' ? 'searchbox' : 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return tag;
  }
  function nameOf(el) {
    var label = el.getAttribute('aria-label'); if (label) return clip(label, 80);
    var by = el.getAttribute('aria-labelledby');
    if (by) { var parts = by.split(/\s+/).map(function (id) { var n = document.getElementById(id); return n ? n.innerText : ''; }); if (clean(parts.join(' '))) return clip(parts.join(' '), 80); }
    if (el.labels && el.labels.length) return clip(el.labels[0].innerText, 80);
    var attrs = ['placeholder', 'alt', 'title', 'name'];
    for (var i = 0; i < attrs.length; i++) { var v = el.getAttribute(attrs[i]); if (v) return clip(v, 80); }
    var text = clean(el.innerText || el.textContent); if (text) return clip(text, 80);
    if (el.value && el.type !== 'password') return clip(String(el.value), 80);
    return '';
  }
  function refOf(el) { if (!el.__ccanvasRef) el.__ccanvasRef = 'e' + (++next); refs.set(el.__ccanvasRef, el); return el.__ccanvasRef; }
  function each(root, visit, depth) {
    root.querySelectorAll(SELECTOR).forEach(visit);
    if (depth > 3) return;
    root.querySelectorAll('*').forEach(function (n) { if (n.shadowRoot) each(n.shadowRoot, visit, depth + 1); });
  }
  function get(ref) {
    var el = refs.get(ref);
    if (!el || !el.isConnected) throw new Error('Unknown or stale ref ' + ref + '; run snapshot again');
    return el;
  }
  function describe(el) { return '[' + el.__ccanvasRef + '] ' + roleOf(el) + (nameOf(el) ? ' "' + nameOf(el) + '"' : ''); }
  function info() {
    return { url: location.href, title: document.title, readyState: document.readyState,
      scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight,
      width: innerWidth, height: innerHeight };
  }
  function snapshot(cmd) {
    refs.clear();
    var lines = []; var limit = 400; var truncated = false;
    each(document, function (el) {
      if (lines.length >= limit) { truncated = true; return; }
      if (!visible(el)) return;
      var ref = refOf(el); var role = roleOf(el); var line = '[' + ref + '] ' + role;
      var name = nameOf(el); if (name) line += ' "' + name + '"';
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
        if (el.type === 'password') line += el.value ? ' value=<hidden>' : ' value=""';
        else if (el.type === 'checkbox' || el.type === 'radio') line += el.checked ? ' checked' : ' unchecked';
        else line += ' value="' + clip(String(el.value || ''), 60) + '"';
      }
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' disabled';
      if (role === 'link' && el.getAttribute('href')) line += ' -> ' + clip(el.getAttribute('href'), 80);
      lines.push(line);
    }, 0);
    var max = Math.min(Math.max(Number(cmd.maxText) || 6000, 500), 20000);
    var text = clean(document.body ? document.body.innerText : '');
    var result = info();
    result.elements = lines; result.elementsTruncated = truncated;
    result.text = text.slice(0, max); result.textTruncated = text.length > max;
    return result;
  }
  function point(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    var r = el.getBoundingClientRect();
    return { bubbles: true, cancelable: true, composed: true, view: window, button: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  }
  function click(cmd) {
    var el = get(cmd.ref); var opts = point(el);
    if (window.PointerEvent) el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    if (el.focus) el.focus();
    if (window.PointerEvent) el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
    return { did: 'clicked ' + describe(el) };
  }
  function setValue(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  }
  function fill(cmd) {
    var el = get(cmd.ref); var text = String(cmd.text == null ? '' : cmd.text);
    point(el); if (el.focus) el.focus();
    if (el.isContentEditable) {
      var range = document.createRange(); range.selectNodeContents(el);
      var sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      if (!document.execCommand('insertText', false, text)) el.textContent = text;
    } else {
      setValue(el, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    var submitted = false;
    if (cmd.submit) {
      var form = el.form || el.closest('form');
      if (form) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); submitted = true; }
    }
    return { did: 'filled ' + describe(el) + (submitted ? ' and submitted its form' : '') };
  }
  function select(cmd) {
    var el = get(cmd.ref); var wanted = String(cmd.value == null ? '' : cmd.value);
    if (el.tagName !== 'SELECT') throw new Error(cmd.ref + ' is not a <select>; use click for custom dropdowns');
    var option = Array.prototype.find.call(el.options, function (o) { return o.value === wanted || clean(o.text) === clean(wanted); });
    if (!option) throw new Error('No option matching "' + wanted + '"');
    setValue(el, option.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { did: 'selected "' + clean(option.text) + '" in ' + describe(el) };
  }
  function press(cmd) {
    var target = cmd.ref ? get(cmd.ref) : (document.activeElement || document.body);
    if (cmd.ref && target.focus) target.focus();
    var key = String(cmd.key || 'Enter');
    var opts = { key: key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, bubbles: true, cancelable: true, composed: true };
    var down = target.dispatchEvent(new KeyboardEvent('keydown', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));
    var submitted = false;
    if (down && key === 'Enter' && target.form && target.tagName === 'INPUT') {
      if (target.form.requestSubmit) target.form.requestSubmit(); else target.form.submit();
      submitted = true;
    }
    return { did: 'pressed ' + key + (submitted ? ' (submitted form)' : '') };
  }
  function scroll(cmd) {
    var amount = Math.min(Math.max(Number(cmd.amount) || 0.8, 0.1), 10) * innerHeight;
    if (cmd.direction === 'top') scrollTo(0, 0);
    else if (cmd.direction === 'bottom') scrollTo(0, document.documentElement.scrollHeight);
    else scrollBy(0, cmd.direction === 'up' ? -amount : amount);
    return { did: 'scrolled ' + (cmd.direction || 'down') };
  }
  function hasText(cmd) { return { found: !!document.body && document.body.innerText.indexOf(String(cmd.text || '')) >= 0 }; }
  function js(cmd) {
    var value = (0, eval)(String(cmd.script || ''));
    var out;
    try { out = JSON.stringify(value); } catch (e) { out = String(value); }
    if (out === undefined) out = 'undefined';
    return { value: out.length > 20000 ? out.slice(0, 20000) + '…' : out };
  }
  var api = { v: 1, info: info, snapshot: snapshot, click: click, fill: fill, select: select, press: press, scroll: scroll, hasText: hasText, js: js };
  window.__ccanvasAgent = api;
  return api;
})()`

export function automationScript(op: string, command: Record<string, unknown>): string {
  const payload = JSON.stringify({ ...command, op })
  return `(function(){try{var a=${AGENT_SOURCE};var c=${payload};var r=a[c.op](c);return JSON.stringify({ok:true,result:r});}catch(e){return JSON.stringify({ok:false,error:String(e&&e.message||e)});}})()`
}

type PageReply = { ok: boolean; result?: Record<string, unknown>; error?: string }

/** Decode the eval callback payload: WebKit JSON-encodes the returned string. */
export function decodePageReply(raw: string): PageReply {
  let value: unknown = JSON.parse(raw)
  if (typeof value === 'string') value = JSON.parse(value)
  if (!value || typeof value !== 'object') throw new Error('Browser returned no result')
  return value as PageReply
}

async function runInPage(portalId: string, op: string, command: Record<string, unknown> = {}) {
  const raw = await invoke<string>('portal_eval', { id: portalId, script: automationScript(op, command) })
  const reply = decodePageReply(raw)
  if (!reply.ok) throw new Error(reply.error ?? 'Browser action failed')
  return reply.result ?? {}
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitForLoad(portalId: string, timeoutMs: number, previousUrl?: string) {
  const deadline = Date.now() + timeoutMs
  let last: Record<string, unknown> = {}
  await sleep(150)
  while (Date.now() < deadline) {
    try {
      last = await runInPage(portalId, 'info')
      const changed = previousUrl === undefined || last.url !== previousUrl
      if (last.readyState === 'complete' && changed) return last
      if (last.readyState === 'complete' && Date.now() + 1000 > deadline) return last
    } catch {
      // The document is being replaced; retry.
    }
    await sleep(250)
  }
  return last
}

// ---------- tool execution ----------

export type BrowserRequest = { action: string; args: Record<string, unknown> }
export type BrowserHost = {
  workspace: Workspace
  agentId: string
  /** Set a web widget's URL so its portal mounts (used by goto on an empty widget). */
  setUrl: (widgetId: string, url: string) => void
}

const str = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length <= max ? value : undefined

function formatSnapshot(name: string, page: Record<string, unknown>): string {
  const elements = Array.isArray(page.elements) ? page.elements as string[] : []
  return [
    `Browser "${name}" · ${page.title || '(untitled)'}`,
    String(page.url ?? ''),
    `viewport ${page.width}x${page.height} · scroll ${page.scrollY}/${page.scrollHeight}`,
    '',
    `Interactive elements (${elements.length}${page.elementsTruncated ? ', truncated' : ''}):`,
    ...(elements.length ? elements : ['(none visible)']),
    '',
    `Page text${page.textTruncated ? ' (truncated)' : ''}:`,
    String(page.text ?? ''),
  ].join('\n')
}

function normalizeUrl(raw: string): string {
  const value = raw.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(value)) return `http://${value}`
  return `https://${value}`
}

/** Execute one `canvas_browser` action for an agent. Returns text for the model. */
export async function executeBrowserRequest(host: BrowserHost, request: BrowserRequest): Promise<string> {
  const { workspace, agentId } = host
  const browsers = connectedBrowsers(workspace, agentId)
  const describeAll = () => browsers
    .map(browser => `- ${browserNameOf(browser)}: ${browser.url || '(no page loaded)'}`)
    .join('\n')

  if (request.action === 'list') {
    return browsers.length
      ? `Connected browsers:\n${describeAll()}\n\nUse canvas_browser with browser=<name>.`
      : 'No browsers are connected to this agent. Ask the user to draw an arrow between this agent and a web widget on the canvas.'
  }
  if (!browsers.length) {
    throw new Error('No browsers are connected to this agent. Ask the user to draw an arrow between this agent and a web widget.')
  }
  const wanted = str(request.args.browser, 64)
  const target = wanted
    ? browsers.find(browser => browserNameOf(browser) === wanted.toLowerCase())
    : browsers.length === 1 ? browsers[0] : undefined
  if (!target) {
    throw new Error(wanted
      ? `Browser "${wanted}" is not connected to this agent. Connected:\n${describeAll()}`
      : `Several browsers are connected; pass browser=<name>:\n${describeAll()}`)
  }
  const name = browserNameOf(target)
  window.dispatchEvent(new CustomEvent(BROWSER_ACTIVITY_EVENT, { detail: { workspaceId: workspace.id, widgetId: target.id } }))

  let portalId = portalFor(workspace.id, target.id)
  if (request.action === 'goto') {
    const url = str(request.args.url, 8192)
    if (!url) throw new Error('goto requires url')
    const normalized = normalizeUrl(url)
    if (!portalId) {
      host.setUrl(target.id, normalized)
      const deadline = Date.now() + 8000
      while (!portalId && Date.now() < deadline) {
        await sleep(100)
        portalId = portalFor(workspace.id, target.id)
      }
      if (!portalId) throw new Error(`Browser "${name}" could not open; is its canvas tab open in the desktop app?`)
      const page = await waitForLoad(portalId, 20_000)
      return `Opened ${page.url ?? normalized} in "${name}" (${page.title || 'untitled'}). Run snapshot to inspect it.`
    }
    const before = await runInPage(portalId, 'info').catch(() => ({} as Record<string, unknown>))
    await navigatePortal(portalId, normalized)
    const page = await waitForLoad(portalId, 20_000, before.url as string | undefined)
    return `Navigated "${name}" to ${page.url ?? normalized} (${page.title || 'untitled'}). Run snapshot to inspect it.`
  }
  if (!portalId) {
    throw new Error(`Browser "${name}" has no page open. Use action "goto" with a url first.`)
  }

  switch (request.action) {
    case 'info': {
      const page = await runInPage(portalId, 'info')
      return `Browser "${name}": ${page.title || '(untitled)'}\n${page.url}\nreadyState ${page.readyState} · scroll ${page.scrollY}/${page.scrollHeight}`
    }
    case 'snapshot':
      return formatSnapshot(name, await runInPage(portalId, 'snapshot', { maxText: request.args.maxText }))
    case 'click':
    case 'fill':
    case 'select':
    case 'press':
    case 'scroll': {
      const command: Record<string, unknown> = {}
      for (const key of ['ref', 'text', 'value', 'key', 'direction', 'amount', 'submit']) {
        if (request.args[key] !== undefined) command[key] = request.args[key]
      }
      if (['click', 'fill', 'select'].includes(request.action) && !str(command.ref, 32)) {
        throw new Error(`${request.action} requires a ref from the latest snapshot`)
      }
      if (typeof command.text === 'string' && command.text.length > 64 * 1024) throw new Error('text is too long')
      const before = await runInPage(portalId, 'info')
      const done = await runInPage(portalId, request.action, command)
      // Clicks and submits often navigate; give the page a moment to settle.
      await sleep(request.action === 'scroll' ? 100 : 400)
      const after = await waitForLoad(portalId, 4000).catch(() => before)
      const moved = after.url && after.url !== before.url ? ` Page is now ${after.url}.` : ''
      return `${done.did} in "${name}".${moved} Run snapshot to see the result.`
    }
    case 'back':
    case 'forward':
    case 'reload': {
      const before = await runInPage(portalId, 'info').catch(() => ({} as Record<string, unknown>))
      await portalAction(portalId, request.action)
      const page = await waitForLoad(portalId, 15_000, request.action === 'reload' ? undefined : before.url as string | undefined)
      return `${request.action} in "${name}": ${page.url ?? ''} (${page.title || 'untitled'})`
    }
    case 'wait': {
      const timeout = Math.min(Math.max(Number(request.args.amount) * 1000 || 10_000, 500), 30_000)
      const text = str(request.args.text, 2000)
      if (!text) {
        const page = await waitForLoad(portalId, timeout)
        return `"${name}" readyState ${page.readyState}: ${page.url}`
      }
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        const found = await runInPage(portalId, 'hasText', { text }).catch(() => ({ found: false }))
        if (found.found) return `Found "${text}" in "${name}".`
        await sleep(300)
      }
      throw new Error(`Timed out waiting for "${text}" in "${name}"`)
    }
    case 'js': {
      const script = str(request.args.script, 64 * 1024)
      if (!script) throw new Error('js requires script')
      const page = await runInPage(portalId, 'js', { script })
      return String(page.value)
    }
    default:
      throw new Error(`Unknown canvas_browser action "${request.action}"`)
  }
}
