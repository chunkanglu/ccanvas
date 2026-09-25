import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const result = await build({
  root, configFile: false, logLevel: 'silent',
  build: {
    write: false, minify: false,
    lib: { entry: `${root}src/lib/pi-runtime.ts`, formats: ['es'] },
  },
})
const bundle = result[0].output.find(entry => entry.type === 'chunk' && entry.isEntry)
const runtimeModule = await import(`data:text/javascript;base64,${Buffer.from(bundle.code).toString('base64')}`)

function fakeBridge(openResult = { reattached: false, generation: 2, companionConnected: false }) {
  const listeners = new Map()
  const calls = []
  const bridge = {
    async listen(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(handler)
      return () => listeners.get(name).delete(handler)
    },
    async invoke(command, args) {
      calls.push([command, args])
      if (command === 'pi_open') {
        // Simulate stale and current events racing with the invoke result.
        emit('pi:pty-data', { id: 'workspace:widget', generation: 1, bytes: [1] })
        emit('pi:pty-data', { id: 'workspace:widget', generation: 2, bytes: [2, 3] })
        emit('pi:companion-status', { id: 'workspace:widget', generation: 2, connected: true })
        emit('pi:companion', {
          id: 'workspace:widget', generation: 2, replayed: false,
          frame: {
            v: 1, type: 'event', widgetId: 'widget', generation: 2, seq: 0,
            event: { type: 'session', phase: 'start', sessionId: 'session' },
          },
        })
        return openResult
      }
      if (command === 'pi_control') {
        emit('pi:companion', {
          id: args.id, generation: args.generation, replayed: false,
          frame: {
            v: 1, type: 'result', widgetId: 'widget', generation: args.generation,
            requestId: args.requestId,
            ok: args.requestId !== 'failed-1',
            ...(args.requestId === 'failed-1' ? { error: 'synthetic control rejection' } : {}),
          },
        })
      }
    },
  }
  const emit = (name, payload) => {
    for (const handler of listeners.get(name) ?? []) handler({ payload })
  }
  return { bridge, calls, listeners, emit }
}

test('semantic prompt follows up whenever a Pi run is active or waiting', () => {
  assert.deepEqual(runtimeModule.managedPiPromptControl('next', true), {
    type: 'prompt', text: 'next', deliverAs: 'followUp',
  })
  assert.deepEqual(runtimeModule.managedPiPromptControl('new', false), {
    type: 'prompt', text: 'new',
  })
})

test('Tauri bundle maps the complete companion import closure', () => {
  const config = JSON.parse(fs.readFileSync(`${root}src-tauri/tauri.conf.json`, 'utf8'))
  const resources = config.bundle.resources
  assert.equal(resources['../scripts/pi-companion-extension.ts'], 'companion/scripts/pi-companion-extension.ts')
  assert.equal(resources['../src/lib/pi-companion-protocol.ts'], 'companion/src/lib/pi-companion-protocol.ts')
  for (const [source, destination] of Object.entries(resources)) {
    if (!destination.startsWith('companion/')) continue
    assert.equal(fs.existsSync(path.resolve(root, 'src-tauri', source)), true, `missing resource ${source}`)
  }
  const extension = fs.readFileSync(`${root}scripts/pi-companion-extension.ts`, 'utf8')
  assert.match(extension, /from ['"]\.\.\/src\/lib\/pi-companion-protocol['"]/)
})

const options = {
  id: 'workspace:widget', widgetId: 'widget', cols: 100, rows: 30, cwd: '/synthetic',
  sessionFile: '/synthetic/session.jsonl', provider: 'anthropic',
  model: 'claude-sonnet-4', thinkingLevel: 'high',
}

test('native transport installs listeners first and rejects stale generations', async () => {
  const fake = fakeBridge()
  const data = [], events = [], deliveries = [], statuses = []
  let exits = 0
  const runtime = await runtimeModule.connectManagedPi(options, {
    onData: value => data.push([...value]),
    onEvent: (value, delivery) => { events.push(value); deliveries.push(delivery) },
    onStatus: value => statuses.push(value),
    onExit: () => { exits++ },
  }, fake.bridge)

  assert.equal(runtime.generation, 2)
  assert.equal(runtime.reused, false)
  assert.deepEqual(data, [[2, 3]])
  assert.equal(events[0].event.sessionId, 'session')
  assert.deepEqual(deliveries, [{ replayed: false }])
  assert.deepEqual(statuses.map(status => status.connected), [false, true])
  assert.equal(exits, 0)
  assert.equal(fake.calls[0][0], 'pi_open')
  const { attachmentId, openEpoch, ...openRequest } = fake.calls[0][1].request
  assert.match(attachmentId, /^[0-9a-f-]{36}$/)
  assert.equal(Number.isSafeInteger(openEpoch) && openEpoch > 0, true)
  assert.deepEqual(openRequest, {
    id: 'workspace:widget', widgetId: 'widget', cols: 100, rows: 30, cwd: '/synthetic',
    sessionFile: '/synthetic/session.jsonl', provider: 'anthropic',
    model: 'claude-sonnet-4', thinkingLevel: 'high',
  })

  runtime.start()
  runtime.start()
  runtime.send('x')
  runtime.resize(120, 40)
  const requestId = await runtime.control({ type: 'abort' }, 'abort-1')
  assert.equal(requestId, 'abort-1')
  await assert.rejects(
    () => runtime.control({ type: 'prompt', text: 'rejected' }, 'failed-1'),
    /synthetic control rejection/,
  )
  assert.equal(fake.calls.filter(([command]) => command === 'pi_start').length, 1)
  assert.ok(fake.calls.some(([command, args]) => command === 'pi_write' && args.generation === 2 && args.attachmentId === attachmentId && args.data === 'x'))
  assert.ok(fake.calls.some(([command, args]) => command === 'pi_resize' && args.attachmentId === attachmentId && args.cols === 120 && args.rows === 40))
  assert.ok(fake.calls.some(([command, args]) => command === 'pi_control' && args.attachmentId === attachmentId && args.requestId === 'abort-1'))

  runtime.close()
  assert.ok(fake.calls.some(([command, args]) => command === 'pi_detach' && args.attachmentId === attachmentId))
  assert.ok([...fake.listeners.values()].every(set => set.size === 0))
  fake.emit('pi:exit', { id: 'workspace:widget', generation: 2 })
  assert.equal(exits, 0)
  await assert.rejects(() => runtime.control({ type: 'abort' }), /closed/)
  runtime.kill()
  assert.ok(fake.calls.some(([command]) => command === 'pi_kill'))
})

test('delete while open is pending kills the returned generation', async () => {
  const listeners = new Map(), calls = []
  let resolveOpen, markOpenStarted
  const openStarted = new Promise(resolve => { markOpenStarted = resolve })
  const openResult = new Promise(resolve => { resolveOpen = resolve })
  const bridge = {
    async listen(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(handler)
      return () => listeners.get(name).delete(handler)
    },
    async invoke(command, args) {
      calls.push([command, args])
      if (command === 'pi_open') {
        markOpenStarted()
        return openResult
      }
    },
  }
  const pendingOptions = { ...options, id: 'workspace:pending-delete', widgetId: 'pending-delete' }
  const connecting = runtimeModule.connectManagedPi(pendingOptions, {
    onData() {}, onEvent() {}, onStatus() {}, onExit() {},
  }, bridge)
  await openStarted
  runtimeModule.killManagedPi(pendingOptions.id, bridge)
  resolveOpen({ reattached: false, generation: 7, companionConnected: false })
  await assert.rejects(connecting, /deleted while opening/)
  assert.ok(calls.some(([command, args]) => command === 'pi_kill_current' && args.id === pendingOptions.id && Number.isSafeInteger(args.deleteEpoch)))
  assert.ok(calls.some(([command, args]) => command === 'pi_kill' && args.id === pendingOptions.id && args.generation === 7 && typeof args.attachmentId === 'string'))
  assert.ok([...listeners.values()].every(set => set.size === 0))
})

test('delete tombstone does not poison an open begun after delete', async () => {
  const listeners = new Map(), calls = [], opens = []
  const bridge = {
    async listen(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(handler)
      return () => listeners.get(name).delete(handler)
    },
    async invoke(command, args) {
      calls.push([command, args])
      if (command === 'pi_open') return new Promise(resolve => opens.push({ resolve, args }))
    },
  }
  const replacementOptions = { ...options, id: 'workspace:delete-undo', widgetId: 'delete-undo' }
  const handlers = { onData() {}, onEvent() {}, onStatus() {}, onExit() {} }
  const original = runtimeModule.connectManagedPi(replacementOptions, handlers, bridge)
  while (opens.length < 1) await Promise.resolve()
  runtimeModule.killManagedPi(replacementOptions.id, bridge)
  const replacement = runtimeModule.connectManagedPi(replacementOptions, handlers, bridge)
  while (opens.length < 2) await Promise.resolve()

  opens[0].resolve({ reattached: false, generation: 1, companionConnected: false })
  opens[1].resolve({ reattached: false, generation: 2, companionConnected: false })
  await assert.rejects(original, /deleted while opening/)
  const live = await replacement
  assert.equal(live.generation, 2)
  assert.equal(opens[0].args.request.openEpoch < opens[1].args.request.openEpoch, true)
  const killed = calls.filter(([command]) => command === 'pi_kill').map(([, args]) => args.generation)
  assert.deepEqual(killed, [1])
  live.kill()
})

test('delete without cached generation asks the backend to kill its current runtime', () => {
  const fake = fakeBridge()
  runtimeModule.killManagedPi('restored-workspace:hidden-widget', fake.bridge)
  assert.equal(fake.calls[0][0], 'pi_kill_current')
  assert.equal(fake.calls[0][1].id, 'restored-workspace:hidden-widget')
  assert.equal(Number.isSafeInteger(fake.calls[0][1].deleteEpoch), true)
})

test('partial listener registration failure releases every fulfilled listener', async () => {
  let registrations = 0, released = 0
  const bridge = {
    async listen() {
      registrations++
      if (registrations === 3) throw new Error('synthetic listener failure')
      return () => { released++ }
    },
    async invoke() { throw new Error('open must not run') },
  }
  await assert.rejects(
    () => runtimeModule.connectManagedPi({ ...options, id: 'workspace:listener-failure' }, {
      onData() {}, onEvent() {}, onStatus() {}, onExit() {},
    }, bridge),
    /synthetic listener failure/,
  )
  assert.equal(released, 3)
})

test('invalid backend generation fails closed and releases listeners', async () => {
  const fake = fakeBridge({ reattached: false, generation: 0, companionConnected: false })
  await assert.rejects(
    () => runtimeModule.connectManagedPi(options, {
      onData() {}, onEvent() {}, onStatus() {}, onExit() {},
    }, fake.bridge),
    /invalid generation/,
  )
  assert.ok([...fake.listeners.values()].every(set => set.size === 0))
})
