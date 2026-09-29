import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const stub = `${root}tests/fixtures/tauri-stub.mjs`
const result = await build({
  root, configFile: false, logLevel: 'silent',
  resolve: { alias: { '@tauri-apps/api/core': stub, '@tauri-apps/api/event': stub } },
  build: { write: false, minify: false, lib: { entry: `${root}tests/fixtures/canvas-agent-entry.ts`, formats: ['es'] } },
})
const bundle = result[0].output.find(entry => entry.type === 'chunk' && entry.isEntry)
const canvas = await import(`data:text/javascript;base64,${Buffer.from(bundle.code).toString('base64')}`)

const agent = (id, extra = {}) => ({ id, type: 'widget', kind: 'agent', harness: 'pi', title: id, x: 0, y: 0, w: 540, h: 380, z: 1, cwd: '/repo', ...extra })
function reset(elements) {
  canvas.useStore.setState({
    tabs: [{ id: 'ws', name: 't', elements, camera: { x: 0, y: 0, zoom: 1 }, dir: '/repo' }],
    activeTabId: 'ws', flowsEnabled: false,
  })
}
const tab = () => canvas.useStore.getState().tabs[0]
const run = (action, args = {}, agentId = 'lead') => canvas.executeCanvasRequest({ workspaceId: 'ws', agentId }, { action, args })

test('paths stay inside the spawning agent folder', () => {
  assert.equal(canvas.containedPath('/repo', undefined), '/repo')
  assert.equal(canvas.containedPath('/repo', 'pkg/a'), '/repo/pkg/a')
  assert.equal(canvas.containedPath('/repo/', './pkg/../src'), '/repo/src')
  assert.equal(canvas.containedPath('/repo', '../etc'), null)
  assert.equal(canvas.containedPath('/repo', '/etc/passwd'), null)
  assert.equal(canvas.containedPath('/repo', '/repo/x'), '/repo/x')
  assert.equal(canvas.containedPath('/repo', '/repository'), null)
})

test('spawned browsers are auto-connected and immediately drivable', async () => {
  reset([agent('lead')])
  const text = await run('spawn_browser', { name: 'Docs', url: 'example.com' })
  assert.match(text, /browser "docs"/)
  const browser = tab().elements.find(element => element.kind === 'web')
  assert.equal(browser.url, 'https://example.com')
  assert.equal(browser.spawnedBy, 'lead')
  assert.ok(browser.x >= 540, 'placed beside the agent')
  const arrow = tab().elements.find(element => element.type === 'arrow')
  assert.deepEqual([arrow.from.id, arrow.to.id, arrow.spawnedBy], ['lead', browser.id, 'lead'])
  assert.deepEqual(canvas.connectedBrowsers(tab(), 'lead').map(el => el.id), [browser.id])
  await assert.rejects(run('spawn_browser', { url: 'file:///etc/passwd' }), /http\(s\)/)
})

test('spawned agents inherit context, start once, and can return output via a flow', async () => {
  reset([agent('lead', { model: 'm1', provider: 'p1' })])
  const text = await run('spawn_agent', { title: 'Researcher', prompt: 'find X', cwd: 'pkg', return_output: true })
  assert.match(text, /Spawned agent "Researcher"/)
  assert.match(text, /flows are paused/)
  const child = tab().elements.find(element => element.title === 'Researcher')
  assert.equal(child.harness, 'pi')
  assert.equal(child.cwd, '/repo/pkg')
  assert.equal(child.promptDraft, 'find X')
  assert.equal(child.spawnedBy, 'lead')
  assert.equal(child.model, 'm1')
  assert.equal(canvas.takeLaunchPrompt('ws', child.id), 'find X')
  assert.equal(canvas.takeLaunchPrompt('ws', child.id), undefined, 'launch prompt is one-shot')
  const back = tab().elements.find(element => element.type === 'arrow' && element.from.id === child.id)
  assert.equal(back.to.id, 'lead')
  assert.equal(back.flow.when, 'always')
  assert.match(back.flow.prompt, /\{\{output\}\}/)
  await assert.rejects(run('spawn_agent', { cwd: '../../etc' }), /inside this agent/)
})

test('agents may only wire and close themselves and what they spawned', async () => {
  reset([agent('lead'), { id: 'mine', type: 'widget', kind: 'web', title: 'user browser', browserName: 'bank', x: 0, y: 900, w: 480, h: 360, z: 1 }])
  await run('spawn_note', { text: 'hello' })
  const note = tab().elements.find(element => element.kind === 'note')
  await assert.rejects(run('connect', { to: 'bank' }), /No connect target/)
  await assert.rejects(run('close', { target: 'bank' }), /No close target/)
  await assert.rejects(run('connect', { to: note.id, when: 'always' }), /only valid between two agents/)
  await run('spawn_agent', { title: 'worker' })
  const worker = tab().elements.find(element => element.title === 'worker')
  assert.match(await run('connect', { from: worker.id, to: 'lead', when: 'success', flow_prompt: 'done: {{output}}' }), /with flow "success"/)
  assert.match(await run('close', { target: 'worker' }), /Closed agent "worker"/)
  assert.equal(tab().elements.some(element => element.id === worker.id), false)
  assert.equal(tab().elements.some(element => element.type === 'arrow' && (element.from.id === worker.id || element.to.id === worker.id)), false, 'arrows removed with the element')
  assert.match(await run('list'), /Spawned by this agent \(1\):\n- .*note/)
})

test('spawn depth, agent count and rate are bounded', async () => {
  reset([agent('root'), agent('child', { spawnedBy: 'root' }), agent('grandchild', { spawnedBy: 'child' })])
  assert.equal(canvas.spawnDepth(tab(), 'grandchild'), 2)
  await assert.rejects(run('spawn_agent', { title: 'deep' }, 'grandchild'), /depth limit/)
  assert.match(await run('spawn_note', { text: 'ok' }, 'grandchild'), /Spawned note/)

  reset([agent('boss')])
  for (let index = 0; index < canvas.CANVAS_LIMITS.maxSpawnedAgents; index++) await run('spawn_agent', { title: `w${index}` }, 'boss')
  await assert.rejects(run('spawn_agent', { title: 'extra' }, 'boss'), /already has 6 spawned agents/)

  reset([agent('fast')])
  for (let index = 0; index < canvas.CANVAS_LIMITS.maxSpawnsPerMinute; index++) await run('spawn_note', { text: `${index}` }, 'fast')
  await assert.rejects(run('spawn_note', { text: 'one more' }, 'fast'), /rate limit/)
})

test('messaging an agent that is not running reports it instead of pretending', async () => {
  reset([agent('lead')])
  await run('spawn_agent', { title: 'idle' })
  await assert.rejects(run('message', { target: 'idle', prompt: 'hi' }), /not running yet/)
  assert.match(await run('status'), /"idle".*: off/)
})

test('arrows are hit and bounded where they are drawn, not at stale stored coordinates', async () => {
  const a = agent('a', { x: 0, y: 0, w: 200, h: 100 })
  const b = agent('b', { x: 600, y: 0, w: 200, h: 100 })
  // bound connector with placeholder coords (what programmatic connectors carry)
  const arrow = { id: 'ar', type: 'arrow', x1: 0, y1: 0, x2: 0, y2: 0, color: '#fff', size: 2, from: { id: 'a' }, to: { id: 'b' }, z: 0 }
  const byId = new Map([a, b, arrow].map(el => [el.id, el]))
  const midpoint = { x: 400, y: 50 }
  assert.equal(canvas.hitTest(arrow, midpoint, 6), false, 'raw geometry misses the drawn line')
  assert.equal(canvas.hitTest(canvas.resolvedArrow(arrow, byId), midpoint, 6), true)
  // bounds used by fit/minimap follow the drawn line, not the origin
  const bounds = canvas.boundsOfMany(canvas.withResolvedArrows([arrow, a, b]).filter(el => el.type === 'arrow'))
  assert.deepEqual([bounds.x, bounds.y, bounds.w, bounds.h], [200, 50, 400, 0])
  // the store docks programmatic connectors when they are added
  reset([a, b])
  canvas.useStore.getState().addElementsInTab('ws', [arrow])
  const stored = tab().elements.find(el => el.id === 'ar')
  assert.deepEqual([stored.x1, stored.y1, stored.x2, stored.y2], [200, 50, 600, 50])
})
