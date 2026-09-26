import assert from 'node:assert/strict'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const result = await build({
  root, configFile: false, logLevel: 'silent',
  build: {
    write: false, minify: false,
    lib: { entry: `${root}scripts/pi-companion-extension.ts`, formats: ['es'] },
    rollupOptions: { external: ['node:net', 'node:os', 'node:path', 'node:url', '@earendil-works/pi-coding-agent'] },
  },
})
const bundle = result[0].output.find(entry => entry.type === 'chunk' && entry.isEntry)
const { default: companion } = await import(`data:text/javascript;base64,${Buffer.from(bundle.code).toString('base64')}`)

const envKeys = [
  'CCANVAS_COMPANION_HOST', 'CCANVAS_COMPANION_PORT', 'CCANVAS_COMPANION_TOKEN',
  'CCANVAS_COMPANION_WIDGET_ID', 'CCANVAS_COMPANION_GENERATION',
]
const runtime = { v: 1, widgetId: 'managed-widget', generation: 9 }
const token = 't'.repeat(43)
const line = value => `${JSON.stringify(value)}\n`

const waitFor = async (predicate, label, timeout = 3000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

test('companion authenticates, replays events, scopes controls and preserves native UI', async t => {
  const records = []
  let peer
  const server = net.createServer(socket => {
    peer = socket
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += chunk
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n')
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (frame) records.push(JSON.parse(frame))
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(async () => {
    peer?.destroy()
    await new Promise(resolve => server.close(resolve))
    for (const key of envKeys) delete process.env[key]
    delete globalThis[Symbol.for('ccanvas.pi.companion.runtime.v1')]
  })

  const handlers = new Map()
  const prompts = []
  const names = []
  let pendingMessages = false
  const configured = { models: [], thinking: [], tools: [] }
  let activeTools = ['read']
  let selectedModel = { provider: 'synthetic-provider', id: 'synthetic-model', name: 'Synthetic' }
  let selectedThinking = 'high'
  const availableModels = [
    selectedModel,
    { provider: 'synthetic-provider', id: 'alternate-model', name: 'Alternate' },
  ]
  const allTools = [
    { name: 'read', description: 'Read files' },
    { name: 'edit', description: 'Edit files' },
  ]
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    sendUserMessage: (text, options) => {
      prompts.push([text, options])
      pendingMessages = options?.deliverAs === 'followUp'
    },
    setSessionName: name => names.push(name),
    getActiveTools: () => activeTools,
    getAllTools: () => allTools,
    setActiveTools: tools => { activeTools = tools; configured.tools.push(tools) },
    setModel: async model => { selectedModel = model; configured.models.push(model.id); return true },
    setThinkingLevel: level => { selectedThinking = level; configured.thinking.push(level) },
  }
  companion(pi)
  assert.equal(handlers.size, 0, 'extension must be inert without manager capability env')

  Object.assign(process.env, {
    CCANVAS_COMPANION_HOST: '127.0.0.1',
    CCANVAS_COMPANION_PORT: String(server.address().port),
    CCANVAS_COMPANION_TOKEN: token,
    CCANVAS_COMPANION_WIDGET_ID: runtime.widgetId,
    CCANVAS_COMPANION_GENERATION: String(runtime.generation),
  })
  companion(pi)
  for (const key of envKeys) assert.equal(process.env[key], undefined, `${key} must not reach tools/children`)

  const calls = { abort: 0, shutdown: 0 }
  const ctx = {
    cwd: '/synthetic/project',
    get model() { return selectedModel },
    get thinkingLevel() { return selectedThinking },
    scopedModels: availableModels.map(model => ({ model })),
    isIdle: () => true,
    hasPendingMessages: () => pendingMessages,
    abort: () => { calls.abort++ },
    shutdown: () => { calls.shutdown++ },
    getContextUsage: () => ({ tokens: null, contextWindow: 1000, percent: null }),
    sessionManager: {
      getEntries: () => [
        { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall' }], usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: { total: 0.12 } } } },
        { type: 'message', message: { role: 'toolResult', usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.03 } } } },
        { type: 'compaction', usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.05 } } },
      ],
      getSessionId: () => 'pi-session-id',
      getSessionFile: () => '/synthetic/session.jsonl',
      getLeafId: () => 'leaf-1',
      getSessionName: () => 'managed test',
    },
  }
  handlers.get('session_start')({ reason: 'startup' }, ctx)
  const hello = await waitFor(() => records.find(frame => frame.type === 'hello'), 'hello')
  assert.equal(hello.token, token)
  assert.equal(hello.widgetId, runtime.widgetId)
  assert.equal(records.some(frame => frame.type === 'event'), false, 'events wait for host authentication')

  peer.write(line({ ...runtime, type: 'welcome', replayFrom: 0 }))
  const session = await waitFor(
    () => records.find(frame => frame.type === 'event' && frame.event.type === 'session'),
    'replayed session event',
  )
  assert.equal(session.event.sessionId, 'pi-session-id')
  assert.equal(session.event.sessionFile, '/synthetic/session.jsonl')
  assert.equal(session.event.leafId, 'leaf-1')
  assert.equal(session.event.model.provider, 'synthetic-provider')
  const catalog = await waitFor(
    () => records.find(frame => frame.type === 'event' && frame.event.type === 'catalog'),
    'model and tool catalog',
  )
  assert.deepEqual(catalog.event.models.map(model => model.id), ['synthetic-model', 'alternate-model'])
  assert.deepEqual(catalog.event.tools.map(tool => [tool.name, tool.active]), [['read', true], ['edit', false]])
  const stats = await waitFor(
    () => records.find(frame => frame.type === 'event' && frame.event.type === 'stats'),
    'Pi session stats',
  )
  assert.equal(stats.event.sessionId, 'pi-session-id')
  assert.deepEqual(stats.event.tokens, { input: 17, output: 6, cacheRead: 1, cacheWrite: 2, total: 26 })
  assert.equal(Math.round(stats.event.costUsd * 100), 20)
  assert.equal(stats.event.toolCalls, 1)
  assert.deepEqual(stats.event.context, { tokens: null, window: 1000, percent: null })

  handlers.get('before_agent_start')({}, ctx)
  handlers.get('agent_start')({}, ctx)
  handlers.get('message_update')({ assistantMessageEvent: { type: 'start', partial: { role: 'assistant', content: [] } } }, ctx)
  handlers.get('message_update')({ assistantMessageEvent: { type: 'text_start' } }, ctx)
  handlers.get('message_update')({ assistantMessageEvent: { type: 'text_delta', delta: 'final STATUS: OK' } }, ctx)
  handlers.get('message_update')({ assistantMessageEvent: { type: 'text_end' } }, ctx)
  handlers.get('message_update')({
    assistantMessageEvent: {
      type: 'done', reason: 'stop',
      message: { role: 'assistant', content: [{ type: 'text', text: 'final STATUS: OK' }] },
    },
  }, ctx)
  handlers.get('tool_execution_start')({ toolCallId: 'tool-1', toolName: 'read', args: { path: '@src/a.ts' } }, ctx)
  handlers.get('tool_execution_end')({ toolCallId: 'tool-1', toolName: 'read', result: 'ok', isError: false }, ctx)
  handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx)
  handlers.get('agent_settled')({}, ctx)
  const settled = await waitFor(
    () => records.find(frame => frame.type === 'event' && frame.event.type === 'lifecycle' && frame.event.phase === 'agent_settled'),
    'settled run envelope',
  )
  assert.equal(settled.event.runId, '9:1')
  assert.equal(settled.event.outcome, 'completed')
  assert.equal(settled.event.assistantText, 'final STATUS: OK')
  assert.ok(records.some(frame => frame.type === 'event' && frame.event.type === 'tool' && frame.event.phase === 'start' && frame.event.resolvedPath === '/synthetic/project/src/a.ts'))
  assert.ok(records.some(frame => frame.type === 'event' && frame.event.type === 'tool' && frame.event.phase === 'end' && frame.event.isError === false))

  handlers.get('before_agent_start')({}, ctx)
  handlers.get('agent_start')({}, ctx)
  handlers.get('message_update')({
    assistantMessageEvent: {
      type: 'error', reason: 'error',
      error: { role: 'assistant', content: [{ type: 'text', text: 'provider failed' }] },
    },
  }, ctx)
  handlers.get('agent_end')({ messages: [] }, ctx)
  handlers.get('agent_settled')({}, ctx)
  const failedSettled = await waitFor(
    () => records.find(frame => frame.type === 'event' && frame.event.type === 'lifecycle' && frame.event.phase === 'agent_settled' && frame.event.runId === '9:2'),
    'failed settled run envelope',
  )
  assert.equal(failedSettled.event.outcome, 'failed')
  assert.equal(failedSettled.event.assistantText, 'provider failed')

  const prompt = { ...runtime, type: 'control', requestId: 'prompt-1', control: { type: 'prompt', text: 'safe synthetic prompt', deliverAs: 'followUp' } }
  peer.write(line(prompt) + line(prompt))
  await waitFor(() => records.filter(frame => frame.type === 'result' && frame.requestId === 'prompt-1').length === 2, 'in-flight deduplicated results')
  assert.deepEqual(prompts, [['safe synthetic prompt', { deliverAs: 'followUp' }]])
  assert.equal(prompts.length, 1, 'simultaneous duplicate request ids must not execute twice')
  assert.ok(records.some(frame => frame.type === 'event' && frame.event.type === 'queue' && frame.event.pending))

  peer.write(line({ ...prompt, control: { type: 'prompt', text: 'conflicting retry' } }))
  const conflicting = await waitFor(
    () => records.filter(frame => frame.type === 'result' && frame.requestId === 'prompt-1')[2],
    'conflicting request-id result',
  )
  assert.equal(conflicting.ok, false)
  assert.match(conflicting.error, /different control/)
  assert.equal(prompts.length, 1, 'conflicting request id must not execute')

  peer.write(line({
    ...runtime, type: 'control', requestId: 'configure-1',
    control: {
      type: 'configure',
      model: { provider: 'synthetic-provider', id: 'alternate-model' },
      thinkingLevel: 'medium',
      activeTools: ['read', 'edit'],
    },
  }))
  const configuredResult = await waitFor(
    () => records.find(frame => frame.type === 'result' && frame.requestId === 'configure-1'),
    'configure result',
  )
  assert.equal(configuredResult.ok, true)
  assert.deepEqual(configured.models, ['alternate-model'])
  assert.deepEqual(configured.thinking, ['medium'])
  assert.deepEqual(configured.tools, [['read', 'edit']])

  peer.write(line({
    ...runtime, type: 'control', requestId: 'tool-toggle-1',
    control: { type: 'configure', tool: { name: 'edit', active: false } },
  }))
  const toggleResult = await waitFor(
    () => records.find(frame => frame.type === 'result' && frame.requestId === 'tool-toggle-1'),
    'tool toggle result',
  )
  assert.equal(toggleResult.ok, true)
  assert.deepEqual(configured.tools.at(-1), ['read'])

  const firstPeer = peer
  firstPeer.destroy()
  await waitFor(
    () => peer !== firstPeer && records.filter(frame => frame.type === 'hello').length === 2,
    'companion reconnect hello',
  )
  const lastEventSeq = Math.max(...records.filter(frame => frame.type === 'event').map(frame => frame.seq))
  peer.write(line({ ...runtime, type: 'welcome', replayFrom: lastEventSeq + 1 }))

  peer.write(line({ ...runtime, type: 'control', requestId: 'rename-1', control: { type: 'rename', name: 'renamed' } }))
  peer.write(line({ ...runtime, type: 'control', requestId: 'abort-1', control: { type: 'abort' } }))
  await waitFor(() => records.some(frame => frame.type === 'result' && frame.requestId === 'abort-1'), 'control results')
  assert.deepEqual(names, ['renamed'])
  assert.equal(calls.abort, 1)

  for (let index = 0; index < 520; index++) {
    handlers.get('session_info_changed')({}, ctx)
  }
  await waitFor(
    () => records.filter(frame => frame.type === 'event' && frame.event.type === 'session').length >= 521,
    'events beyond replay cap',
  )
  const beforeGapReconnect = records.length
  const secondPeer = peer
  secondPeer.destroy()
  await waitFor(
    () => peer !== secondPeer && records.filter(frame => frame.type === 'hello').length === 3,
    'gap reconnect hello',
  )
  peer.write(line({ ...runtime, type: 'welcome', replayFrom: 0 }))
  const reset = await waitFor(
    () => records.slice(beforeGapReconnect).find(
      frame => frame.type === 'event' && frame.event.type === 'runtime_error' && frame.event.code === 'replay_reset_complete',
    ),
    'replay reset completion',
  )
  const recovered = records.slice(beforeGapReconnect).filter(
    frame => frame.type === 'event' && frame.seq < reset.seq,
  )
  assert.ok(recovered.some(frame => frame.event.type === 'runtime_error' && frame.event.code === 'replay_gap'))
  assert.ok(recovered.some(frame => frame.event.type === 'session' && frame.event.sessionId === 'pi-session-id'))

  handlers.get('message_update')({
    assistantMessageEvent: { type: 'text_delta', delta: 'y'.repeat(300_000) },
  }, ctx)
  const assistant = await waitFor(
    () => records.find(frame => frame.type === 'event' && frame.event.type === 'assistant' && frame.event.truncated === true),
    'bounded assistant event',
  )
  assert.equal(assistant.event.truncated, true)
  assert.ok(assistant.event.text.length <= 32_768)

  handlers.get('tool_execution_start')({
    toolCallId: 'large-call', toolName: 'read', args: { value: 'x'.repeat(300_000) },
  }, ctx)
  const tool = await waitFor(
    () => records.find(frame => frame.type === 'event' && frame.event.type === 'tool' && frame.event.truncated === true),
    'bounded tool event',
  )
  assert.equal(tool.event.truncated, true)
  assert.equal(tool.event.input, undefined)

  handlers.get('session_shutdown')({ reason: 'quit' }, ctx)
  const shutdown = await waitFor(
    () => records.find(frame => frame.type === 'event' && frame.event.type === 'session' && frame.event.phase === 'shutdown'),
    'shutdown event',
  )
  assert.equal(shutdown.event.reason, 'quit')
  assert.equal('ui' in pi, false, 'companion must not patch or replace native UI')
})
