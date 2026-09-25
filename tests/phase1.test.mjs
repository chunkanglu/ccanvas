import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const result = await build({
  root, configFile: false, logLevel: 'silent',
  build: {
    write: false, minify: false,
    lib: { entry: `${root}src/lib/agent-controller.ts`, formats: ['es'] },
  },
})
const bundle = result[0].output.find(entry => entry.type === 'chunk' && entry.isEntry)
const controller = await import(`data:text/javascript;base64,${Buffer.from(bundle.code).toString('base64')}`)

const base = {
  id: 'widget-1', type: 'widget', kind: 'agent', title: 'agent',
  x: 0, y: 0, w: 100, h: 100, z: 0,
}

test('launch spec keeps harness, provider and runtime identities separate', () => {
  const spec = controller.launchSpecFor({
    ...base,
    harness: 'pi',
    sessionId: 'pi-id',
    sessionFile: '/synthetic/pi-session.jsonl',
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    thinkingLevel: 'high',
    toolProfile: 'dev',
    cwd: '/synthetic/worktree',
  }, 7, '/ignored')
  assert.deepEqual(spec, {
    widgetId: 'widget-1', generation: 7, harness: 'pi', cwd: '/synthetic/worktree',
    session: { sessionId: 'pi-id', sessionFile: '/synthetic/pi-session.jsonl' },
    provider: 'anthropic', model: 'claude-sonnet-4', thinkingLevel: 'high',
    toolProfile: 'dev', initialPrompt: undefined,
  })
  assert.notEqual(spec.widgetId, spec.session.sessionId)
})

test('missing or malformed harness fails closed to Claude', () => {
  assert.equal(controller.launchSpecFor(base, 1, '/workspace').harness, 'claude')
  assert.equal(controller.launchSpecFor({ ...base, harness: 'unknown' }, 2).harness, 'claude')
  assert.throws(() => controller.launchSpecFor({ ...base, kind: 'terminal' }, 1), /agent widget/)
  assert.throws(() => controller.launchSpecFor(base, 0), /positive safe integer/)
})

test('generation gate rejects stale, duplicate and out-of-order events', () => {
  const gate = new controller.AgentEventGate()
  gate.attach({ widgetId: 'widget-1', generation: 1 })
  const event = (generation, seq) => ({
    type: 'lifecycle', widgetId: 'widget-1', generation, seq, state: 'idle',
  })
  assert.equal(gate.accept(event(1, 0)), true)
  assert.equal(gate.accept(event(1, 0)), false)
  assert.equal(gate.accept(event(1, 2)), true)
  assert.equal(gate.accept(event(1, 1)), false)
  assert.throws(() => gate.attach({ widgetId: 'widget-1', generation: 1 }), /monotonically/)
  gate.attach({ widgetId: 'widget-1', generation: 2 })
  assert.equal(gate.accept(event(1, 3)), false)
  assert.equal(gate.accept(event(2, 0)), true)
  assert.equal(gate.detach({ widgetId: 'widget-1', generation: 1 }), false)
  assert.equal(gate.detach({ widgetId: 'widget-1', generation: 2 }), true)
  assert.equal(gate.accept(event(2, 1)), false)
  assert.equal(gate.accept(event(2, Number.NaN)), false)
  assert.throws(() => gate.attach({ widgetId: 'widget-1', generation: 2 }), /monotonically/)
  assert.throws(() => gate.attach({ widgetId: 'widget-1', generation: 1 }), /monotonically/)
  gate.attach({ widgetId: 'widget-1', generation: 3 })
  assert.equal(gate.accept(event(3, 0)), true)
})
