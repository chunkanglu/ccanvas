import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const result = await build({
  root, configFile: false, logLevel: 'silent',
  build: {
    write: false, minify: false,
    lib: { entry: `${root}src/lib/agents.ts`, formats: ['es'] },
  },
})
const bundle = result[0].output.find(entry => entry.type === 'chunk' && entry.isEntry)
const agents = await import(`data:text/javascript;base64,${Buffer.from(bundle.code).toString('base64')}`)

test('runtime agent identity scopes duplicate canvas widgets by workspace', () => {
  const widget = { id: 'portable-widget', kind: 'agent', harness: 'pi' }
  assert.equal(agents.agentRuntimeId('workspace-a', widget), 'workspace-a:portable-widget')
  assert.equal(agents.agentRuntimeId('workspace-b', widget), 'workspace-b:portable-widget')
  assert.notEqual(agents.agentRuntimeId('workspace-a', widget), agents.agentRuntimeId('workspace-b', widget))
})

test('Pi semantic prompt and rename do not inject native TUI bytes and surface failures', async () => {
  const raw = [], prompts = [], drafts = [], names = []
  const id = 'workspace:semantic-pi'
  const owner = agents.registerTransport(id, {
    send: value => raw.push(value),
    prompt: value => prompts.push(value),
    insertDraft: value => drafts.push(value),
    rename: value => names.push(value),
    kind: 'agent',
    title: 'Pi',
  })
  assert.equal(agents.sendPrompt(id, 'run safely'), true)
  assert.equal(agents.renameSession(id, 'new name'), true)
  assert.deepEqual(prompts, ['run safely'])
  assert.deepEqual(names, ['new name'])
  assert.deepEqual(raw, [])
  assert.equal(agents.sendPrompt(id, 'editable draft', false), true)
  assert.deepEqual(drafts, ['editable draft'])
  assert.deepEqual(raw, [])
  agents.unregisterTransport(id, owner)

  const terminalOwner = agents.registerTransport(id, {
    send: value => raw.push(value), kind: 'agent', title: 'terminal-backed',
  })
  assert.equal(agents.sendPrompt(id, 'editable paste', false), true)
  assert.deepEqual(raw, ['editable paste'])
  agents.unregisterTransport(id, terminalOwner)

  const errors = []
  const originalError = console.error
  console.error = message => errors.push(String(message))
  try {
    const rejectingOwner = agents.registerTransport(id, {
      send: value => raw.push(value),
      prompt: () => Promise.reject(new Error('synthetic rejection')),
      kind: 'agent',
      title: 'Pi',
    })
    assert.equal(agents.sendPrompt(id, 'will reject'), true)
    await Promise.resolve()
    await Promise.resolve()
    assert.ok(errors.some(message => message.includes('synthetic rejection')))
    assert.deepEqual(await agents.deliverPrompt(id, 'retain me'), {
      id, status: 'rejected', error: 'synthetic rejection',
    })
    agents.unregisterTransport(id, rejectingOwner)
    assert.deepEqual(await agents.deliverPrompt(id, 'offline'), { id, status: 'offline' })
  } finally {
    console.error = originalError
  }
})

test('stale attachment cleanup cannot unregister a replacement transport', () => {
  const delivered = []
  const id = 'workspace:widget'
  const first = agents.registerTransport(id, { send: value => delivered.push(['first', value]), kind: 'agent', title: 'first' })
  const second = agents.registerTransport(id, { send: value => delivered.push(['second', value]), kind: 'agent', title: 'second' })

  assert.equal(agents.unregisterTransport(id, first), false)
  assert.equal(agents.sendTo(id, 'hello'), true)
  assert.deepEqual(delivered, [['second', 'hello']])
  assert.equal(agents.unregisterTransport(id, second), true)
  assert.equal(agents.isLive(id), false)
})
