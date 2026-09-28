import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const stub = `${root}tests/fixtures/tauri-stub.mjs`
const result = await build({
  root, configFile: false, logLevel: 'silent',
  resolve: { alias: { '@tauri-apps/api/core': stub, '@tauri-apps/api/event': stub } },
  build: { write: false, minify: false, lib: { entry: `${root}tests/fixtures/browser-agent-entry.ts`, formats: ['es'] } },
})
const bundle = result[0].output.find(entry => entry.type === 'chunk' && entry.isEntry)
const agent = await import(`data:text/javascript;base64,${Buffer.from(bundle.code).toString('base64')}`)
globalThis.window ??= { dispatchEvent: () => true }
globalThis.CustomEvent ??= class { constructor(type, init) { this.type = type; this.detail = init?.detail } }

const web = (id, extra = {}) => ({ id, type: 'widget', kind: 'web', x: 0, y: 0, w: 1, h: 1, z: 1, title: id, ...extra })
const pi = (id, harness = 'pi') => ({ id, type: 'widget', kind: 'agent', harness, x: 0, y: 0, w: 1, h: 1, z: 1, title: id })
const arrow = (id, from, to) => ({ id, type: 'arrow', x1: 0, y1: 0, x2: 1, y2: 1, size: 1, color: '#fff', z: 1, from: { id: from }, to: { id: to } })
const reply = result => JSON.stringify(JSON.stringify({ ok: true, result }))

test('browser names are valid, stable and unique per canvas', () => {
  assert.equal(agent.browserNameOf({ id: 'Ab12cd', browserName: 'docs' }), 'docs')
  assert.equal(agent.browserNameOf({ id: 'Ab12cd', browserName: 'Bad Name!' }), 'browser-ab12')
  assert.equal(agent.normalizeBrowserName('  My GitHub!! '), 'my-github')
  const elements = [web('a', { browserName: 'browser' }), web('b', { browserName: 'browser-2' })]
  assert.equal(agent.uniqueBrowserName(elements), 'browser-3')
  assert.equal(agent.uniqueBrowserName(elements, 'browser', 'a'), 'browser')
})

test('agents reach only arrow-connected URL web widgets, in either direction', () => {
  const workspace = { id: 'ws', elements: [
    pi('agent'), pi('other'), web('w1', { browserName: 'docs' }), web('w2', { browserName: 'mail' }),
    web('local', { path: '/tmp/a.html' }), web('w3'),
    arrow('a1', 'agent', 'w1'), arrow('a2', 'w2', 'agent'), arrow('a3', 'agent', 'local'), arrow('a4', 'other', 'w3'),
  ] }
  assert.deepEqual(agent.connectedBrowsers(workspace, 'agent').map(el => el.id).sort(), ['w1', 'w2'])
  assert.deepEqual(agent.agentsDriving(workspace, 'w3').map(el => el.id), ['other'])
  const claude = { id: 'ws', elements: [pi('c', 'claude'), web('w'), arrow('x', 'c', 'w')] }
  assert.deepEqual(agent.agentsDriving(claude, 'w'), [])
})

test('tool execution is scoped to connected browsers and resolves names', async () => {
  const workspace = { id: 'ws', elements: [pi('agent'), web('w1', { browserName: 'docs', url: 'https://a.test' }), web('w2', { browserName: 'mail' }), arrow('a1', 'agent', 'w1')] }
  const host = { workspace, agentId: 'agent', setUrl: () => {} }
  assert.match(await agent.executeBrowserRequest(host, { action: 'list', args: {} }), /- docs: https:\/\/a\.test/)
  await assert.rejects(agent.executeBrowserRequest(host, { action: 'snapshot', args: { browser: 'mail' } }), /not connected to this agent/)
  await assert.rejects(agent.executeBrowserRequest({ ...host, workspace: { id: 'ws', elements: [pi('agent')] } }, { action: 'snapshot', args: {} }), /No browsers are connected/)
  await assert.rejects(agent.executeBrowserRequest(host, { action: 'snapshot', args: {} }), /no page open/)

  const off = agent.registerPortal('ws', 'w1', 'portal:1')
  agent.calls.length = 0
  agent.setReply(() => reply({ url: 'https://a.test', title: 'A', width: 800, height: 600, scrollY: 0, scrollHeight: 900, elements: ['[e1] button "Go"'], text: 'hello' }))
  const snapshot = await agent.executeBrowserRequest(host, { action: 'snapshot', args: {} })
  assert.match(snapshot, /Browser "docs" · A/)
  assert.match(snapshot, /\[e1\] button "Go"/)
  assert.equal(agent.calls[0].command, 'portal_eval')
  assert.equal(agent.calls[0].args.id, 'portal:1')
  await assert.rejects(agent.executeBrowserRequest(host, { action: 'click', args: {} }), /requires a ref/)
  await assert.rejects(agent.executeBrowserRequest(host, { action: 'teleport', args: {} }), /Unknown canvas_browser action/)
  agent.setReply(() => JSON.stringify(JSON.stringify({ ok: false, error: 'Unknown or stale ref e9; run snapshot again' })))
  await assert.rejects(agent.executeBrowserRequest(host, { action: 'click', args: { ref: 'e9' } }), /stale ref e9/)
  off()
})

test('goto on an empty browser loads it through the widget URL', async () => {
  const workspace = { id: 'ws', elements: [pi('agent'), web('w1', { browserName: 'docs' }), arrow('a1', 'agent', 'w1')] }
  let loaded
  const host = {
    workspace,
    agentId: 'agent',
    setUrl: (widgetId, url) => { loaded = url; setTimeout(() => agent.registerPortal('ws', widgetId, 'portal:2'), 20) },
  }
  agent.setReply(() => reply({ url: 'https://example.com/', title: 'Example', readyState: 'complete' }))
  const text = await agent.executeBrowserRequest(host, { action: 'goto', args: { url: 'example.com' } })
  assert.equal(loaded, 'https://example.com')
  assert.match(text, /Opened https:\/\/example\.com\/ in "docs"/)
})

test('injected automation is valid JavaScript and replies are decoded', () => {
  const script = agent.automationScript('snapshot', { maxText: 100, ref: '"; alert(1); //' })
  assert.doesNotThrow(() => new Function(`return ${script}`))
  assert.match(script, /"ref":"\\"; alert\(1\); \/\/"/)
  assert.deepEqual(agent.decodePageReply(reply({ a: 1 })), { ok: true, result: { a: 1 } })
  assert.deepEqual(agent.decodePageReply(JSON.stringify({ ok: false, error: 'x' })), { ok: false, error: 'x' })
})
