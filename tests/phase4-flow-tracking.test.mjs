import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const result = await build({
  root, configFile: false, logLevel: 'silent',
  build: {
    write: false, minify: false,
    lib: { entry: `${root}tests/fixtures/phase4-entry.ts`, formats: ['es'] },
  },
})
const bundle = result[0].output.find(entry => entry.type === 'chunk' && entry.isEntry)
const phase4 = await import(`data:text/javascript;base64,${Buffer.from(bundle.code).toString('base64')}`)
const trackedChanges = []
globalThis.window ??= {
  innerWidth: 1440,
  innerHeight: 900,
  dispatchEvent: event => { trackedChanges.push(event.detail.path); return true },
}
globalThis.CustomEvent ??= class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function agent(id, x = 0) {
  return {
    id, type: 'widget', kind: 'agent', harness: 'pi', title: id,
    x, y: 0, w: 600, h: 400, z: 1, cwd: '/tmp',
  }
}
function edge(id, from, to, flow, z = 1) {
  return {
    id, type: 'arrow', x1: 0, y1: 0, x2: 1, y2: 1, size: 2,
    color: '#fff', z, from: { id: from }, to: { id: to }, flow,
  }
}
function workspace(elements) {
  return { id: 'ws', name: 'test', elements, camera: { x: 0, y: 0, zoom: 1 } }
}
function arm(elements) {
  phase4.resetFlowState()
  phase4.useStore.setState({ tabs: [workspace(elements)], activeTabId: 'ws', flowsEnabled: true })
}
function run(sourceId, runId, assistantText, outcome = 'completed') {
  return phase4.onAgentRunSettled({
    sourceId, workspaceId: 'ws', harness: 'pi', generation: 4,
    runId, outcome, assistantText,
  })
}

// Conditions consume one authoritative final text and keep run failure separate
// from heuristic task-failure words.
test('flow conditions separate run outcome from text heuristics', () => {
  const base = edge('e', 'a', 'b', { enabled: true, when: 'always', prompt: 'go' })
  assert.equal(phase4.evaluateCondition(base, 'done', 'completed'), true)
  assert.equal(phase4.evaluateCondition(base, 'done', 'failed'), false)
  assert.equal(phase4.evaluateCondition(base, 'done', 'aborted'), false)
  base.flow.when = 'failure'
  assert.equal(phase4.evaluateCondition(base, 'tests failed', 'completed'), true)
  assert.equal(phase4.evaluateCondition(base, 'tests failed', 'failed'), false)
  base.flow.when = 'runtime-error'
  assert.equal(phase4.evaluateCondition(base, 'looks successful', 'failed'), true)
  assert.equal(phase4.evaluateCondition(base, 'failed', 'completed'), false)
})

test('settled flow delivers once with a stable request id and exact output', async () => {
  const elements = [
    agent('a'), agent('b', 700),
    edge('ab', 'a', 'b', { enabled: true, when: 'match', pattern: 'STATUS: OK$', prompt: 'Review:\n{{output}}' }),
  ]
  arm(elements)
  const calls = []
  const owner = phase4.registerTransport('ws:b', {
    kind: 'agent', title: 'b', send() {},
    prompt: async (text, requestId) => calls.push({ text, requestId }),
  })
  try {
    await run('a', 'run-1', 'result body\nSTATUS: OK')
    await tick()
    await run('a', 'run-1', 'result body\nSTATUS: OK')
    await tick()
    assert.deepEqual(calls.map(call => call.text), ['Review:\nresult body\nSTATUS: OK'])
    assert.match(calls[0].requestId, /^flow-[a-z0-9]+$/)
    assert.equal(phase4.flowDeliveryState(calls[0].requestId), 'accepted')
  } finally {
    phase4.unregisterTransport('ws:b', owner)
  }
})

test('AND joins keep the first edge result and graph edits reset pending evidence', async () => {
  const a = agent('a')
  const c = agent('c', 350)
  const b = agent('b', 700)
  const ab = edge('ab', 'a', 'b', { enabled: true, when: 'always', prompt: 'A={{output}}' }, 1)
  const cb = edge('cb', 'c', 'b', { enabled: true, when: 'always', prompt: 'C={{output}}' }, 2)
  arm([a, b, c, ab, cb])
  const calls = []
  const owner = phase4.registerTransport('ws:b', {
    kind: 'agent', title: 'b', send() {}, prompt: async text => calls.push(text),
  })
  try {
    await run('a', 'a1', 'first A')
    await run('a', 'a2', 'newer A')
    await run('c', 'c1', 'first C')
    await tick()
    assert.deepEqual(calls, ['A=first A\n\nC=first C'])

    // Begin another join, then edit the graph before C settles. Old A evidence
    // must not cross the revision boundary.
    await run('a', 'a3', 'stale A')
    ab.flow.prompt = 'changed={{output}}'
    phase4.useStore.setState({ tabs: [workspace([a, b, c, ab, cb])] })
    await run('c', 'c2', 'new C')
    await tick()
    assert.equal(calls.length, 1)
    await run('a', 'a4', 'fresh A')
    await tick()
    assert.equal(calls[1], 'changed=fresh A\n\nC=new C')
  } finally {
    phase4.unregisterTransport('ws:b', owner)
  }
})

test('OR joins fire only the triggering any-edge and consume older pending evidence', async () => {
  const elements = [
    agent('a'), agent('b', 700), agent('c', 350),
    edge('ab', 'a', 'b', { enabled: true, when: 'always', join: 'any', prompt: 'A={{output}}' }, 1),
    edge('cb', 'c', 'b', { enabled: true, when: 'always', join: 'all', prompt: 'C={{output}}' }, 2),
  ]
  arm(elements)
  const calls = []
  const owner = phase4.registerTransport('ws:b', {
    kind: 'agent', title: 'b', send() {}, prompt: async text => calls.push(text),
  })
  try {
    await run('c', 'c1', 'pending C')
    await run('a', 'a1', 'trigger A')
    await tick()
    assert.deepEqual(calls, ['A=trigger A'])
    await run('c', 'c2', 'fresh C')
    await tick()
    assert.equal(calls.length, 1)
  } finally {
    phase4.unregisterTransport('ws:b', owner)
  }
})

test('uncertain semantic delivery is recorded and never retried', async () => {
  arm([agent('a'), agent('b', 700), edge('ab', 'a', 'b', { enabled: true, when: 'always', prompt: 'go' })])
  const ids = []
  const owner = phase4.registerTransport('ws:b', {
    kind: 'agent', title: 'b', send() {},
    prompt: async (_text, requestId) => {
      ids.push(requestId)
      const error = new Error('ack lost')
      error.deliveryCertainty = 'uncertain'
      throw error
    },
  })
  try {
    await run('a', 'r1', 'done')
    await tick()
    assert.equal(ids.length, 1)
    assert.equal(phase4.flowDeliveryState(ids[0]), 'uncertain')
    await run('a', 'r1', 'done')
    await tick()
    assert.equal(ids.length, 1)
  } finally {
    phase4.unregisterTransport('ws:b', owner)
  }
})

test('pause during acknowledgement never resends an accepted delivery after re-arm', async () => {
  arm([agent('a'), agent('b', 700), edge('ab', 'a', 'b', { enabled: true, when: 'always', prompt: 'go' })])
  let resolvePrompt
  const calls = []
  const owner = phase4.registerTransport('ws:b', {
    kind: 'agent', title: 'b', send() {},
    prompt: (text, requestId) => {
      calls.push({ text, requestId })
      return new Promise(resolve => { resolvePrompt = resolve })
    },
  })
  try {
    await run('a', 'r1', 'done')
    await tick()
    assert.equal(calls.length, 1)
    phase4.useStore.getState().setFlowsEnabled(false)
    resolvePrompt()
    await tick()
    phase4.useStore.getState().setFlowsEnabled(true)
    await run('a', 'r1', 'done')
    await tick()
    assert.equal(calls.length, 1)
    assert.equal(phase4.flowDeliveryState(calls[0].requestId), 'accepted')
  } finally {
    phase4.unregisterTransport('ws:b', owner)
  }
})

test('structured tracking maps only explicit file tools and filters sensitive paths', () => {
  assert.deepEqual(phase4.structuredToolFile('read', { path: 'src/a.ts' }), {
    path: 'src/a.ts', tool: 'read', mutate: false,
  })
  assert.deepEqual(phase4.structuredToolFile('WRITE', { path: '/tmp/a' }), {
    path: '/tmp/a', tool: 'write', mutate: true,
  })
  assert.equal(phase4.structuredToolFile('bash', { command: 'cat /tmp/a' }), null)
  assert.equal(phase4.structuredToolFile('custom_read', { path: '/tmp/a' }), null)
  assert.equal(phase4.structuredToolFile('edit', { file_path: '/tmp/a' }), null)
  assert.equal(phase4.isSensitiveTrackedPath('/repo/.env.local'), true)
  assert.equal(phase4.isSensitiveTrackedPath('/Users/me/.ssh/id_ed25519'), true)
  assert.equal(phase4.isSensitiveTrackedPath('/repo/src/keymap.ts'), false)
})

test('Pi tracking requires a successful non-replayed start/end pair and rejects stale generations', async () => {
  const a = agent('a')
  arm([a])
  assert.equal(await phase4.startTracking('a', 'ws'), true)
  const emit = event => phase4.onStructuredToolEvent({
    agentId: 'a', workspaceId: 'ws', generation: 4, replayed: false,
    name: 'read', ...event,
  })
  try {
    emit({ seq: 1, replayed: true, phase: 'start', callId: 'replay', input: { path: 'ignored.ts' } })
    emit({ seq: 2, phase: 'end', callId: 'replay', isError: false })
    emit({ seq: 3, phase: 'start', callId: 'secret', input: { path: '.env' } })
    emit({ seq: 4, phase: 'end', callId: 'secret', isError: false })
    emit({ seq: 5, phase: 'start', callId: 'failed', name: 'edit', input: { path: 'src/a.ts' } })
    emit({ seq: 6, phase: 'end', callId: 'failed', name: 'edit', isError: true })
    assert.equal(phase4.useStore.getState().tabs[0].elements.filter(element => element.trackOf === 'a').length, 0)

    emit({ seq: 7, phase: 'start', callId: 'ok', name: 'edit', input: { path: 'src/a.ts' } })
    emit({ seq: 8, phase: 'end', callId: 'ok', name: 'edit', isError: false })
    let tracked = phase4.useStore.getState().tabs[0].elements.filter(element => element.trackOf === 'a')
    assert.equal(tracked.filter(element => element.type === 'widget').length, 1)
    assert.equal(tracked.find(element => element.type === 'widget').path, '/tmp/src/a.ts')

    phase4.onStructuredToolEvent({
      agentId: 'a', workspaceId: 'ws', generation: 5, seq: 1, replayed: false,
      phase: 'start', callId: 'new', name: 'write', input: { path: 'src/b.ts' },
    })
    phase4.onStructuredToolEvent({
      agentId: 'a', workspaceId: 'ws', generation: 4, seq: 99, replayed: false,
      phase: 'end', callId: 'new', name: 'write', isError: false,
    })
    phase4.onStructuredToolEvent({
      agentId: 'a', workspaceId: 'ws', generation: 5, seq: 2, replayed: false,
      phase: 'end', callId: 'new', name: 'write', isError: false,
    })
    tracked = phase4.useStore.getState().tabs[0].elements.filter(element => element.trackOf === 'a')
    assert.equal(tracked.filter(element => element.type === 'widget').length, 2)

    // The companion's runtime-resolved path wins over the widget's portable cwd.
    phase4.onStructuredToolEvent({
      agentId: 'a', workspaceId: 'ws', generation: 5, seq: 3, replayed: false,
      phase: 'start', callId: 'resolved', name: 'write', input: { path: 'relative.txt' },
      resolvedPath: '/runtime/project/relative.txt',
    })
    phase4.onStructuredToolEvent({
      agentId: 'a', workspaceId: 'ws', generation: 5, seq: 4, replayed: false,
      phase: 'end', callId: 'resolved', name: 'write', isError: false,
    })
    tracked = phase4.useStore.getState().tabs[0].elements.filter(element => element.trackOf === 'a')
    assert.ok(tracked.some(element => element.type === 'widget' && element.path === '/runtime/project/relative.txt'))

    phase4.onStructuredToolEvent({
      agentId: 'a', workspaceId: 'ws', generation: 5, seq: 5, replayed: false,
      phase: 'start', callId: 'resolved-edit', name: 'edit', input: { path: 'relative.txt' },
      resolvedPath: '/runtime/project/relative.txt',
    })
    phase4.onStructuredToolEvent({
      agentId: 'a', workspaceId: 'ws', generation: 5, seq: 6, replayed: false,
      phase: 'end', callId: 'resolved-edit', name: 'edit', isError: false,
    })
    assert.ok(trackedChanges.includes('/runtime/project/relative.txt'))
  } finally {
    phase4.stopTracking(true)
  }
})

test('frontend defaults flows to paused and Pi emits structured run/tool signals', async () => {
  const selectionBar = await readFile(`${root}src/ui/SelectionBar.tsx`, 'utf8')
  assert.match(selectionBar, /key=\{`label:\$\{loneArrow\.id\}`\}/)
  assert.match(selectionBar, /key=\{`pattern:\$\{loneArrow!\.id\}`\}/)
  assert.match(selectionBar, /key=\{`prompt:\$\{loneArrow!\.id\}`\}/)
  const store = await readFile(`${root}src/store/workspace.ts`, 'utf8')
  assert.match(store, /flowsEnabled: false/)
  const piBody = await readFile(`${root}src/widgets/PiTerminalBody.tsx`, 'utf8')
  assert.match(piBody, /onAgentRunSettled\(/)
  assert.match(piBody, /onStructuredToolEvent\(/)
  const companion = await readFile(`${root}scripts/pi-companion-extension.ts`, 'utf8')
  assert.match(companion, /assistantText: runtime\.currentAssistantText/)
  assert.match(companion, /runId: runtime\.currentRunId/)
})
