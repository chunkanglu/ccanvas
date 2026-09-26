import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const result = await build({
  root, configFile: false, logLevel: 'silent',
  build: {
    write: false, minify: false,
    lib: { entry: `${root}src/lib/pi-companion-protocol.ts`, formats: ['es'] },
  },
})
const bundle = result[0].output.find(entry => entry.type === 'chunk' && entry.isEntry)
const protocol = await import(`data:text/javascript;base64,${Buffer.from(bundle.code).toString('base64')}`)

const runtime = { v: 1, widgetId: 'widget-1', generation: 4 }
const token = 'a'.repeat(43)

const frames = [
  { ...runtime, type: 'hello', token, pid: 123 },
  { ...runtime, type: 'welcome', replayFrom: 0 },
  { ...runtime, type: 'event', seq: 0, event: { type: 'session', phase: 'start', sessionId: 'session-1', sessionFile: '/tmp/session.jsonl' } },
  { ...runtime, type: 'event', seq: 1, event: { type: 'tool', phase: 'start', callId: 'call-1', name: 'read', input: { path: 'safe-fixture' }, resolvedPath: '/tmp/safe-fixture' } },
  { ...runtime, type: 'control', requestId: 'request-1', control: { type: 'prompt', text: 'hello', deliverAs: 'followUp' } },
  { ...runtime, type: 'result', requestId: 'request-1', ok: true },
  { ...runtime, type: 'ping', nonce: 'host-1' },
  { ...runtime, type: 'pong', nonce: 'host-1' },
  { ...runtime, type: 'event', seq: 2, event: { type: 'queue', pending: true } },
  {
    ...runtime, type: 'event', seq: 3,
    event: {
      type: 'lifecycle', phase: 'agent_settled', runId: '7:3', outcome: 'completed',
      assistantText: 'STATUS: OK', truncated: false,
    },
  },
  {
    ...runtime, type: 'event', seq: 4,
    event: {
      type: 'catalog',
      models: [{ provider: 'synthetic', id: 'model-1', name: 'Model One' }],
      thinkingLevels: ['off', 'high'],
      tools: [{ name: 'read', description: 'Read files', active: true }],
    },
  },
  {
    ...runtime, type: 'control', requestId: 'configure-1',
    control: {
      type: 'configure', model: { provider: 'synthetic', id: 'model-1' },
      thinkingLevel: 'high', activeTools: ['read'],
    },
  },
  {
    ...runtime, type: 'control', requestId: 'tool-toggle-1',
    control: { type: 'configure', tool: { name: 'read', active: false } },
  },
]

test('versioned frames round-trip and preserve distinct runtime identity', () => {
  for (const frame of frames) {
    const encoded = protocol.encodePiCompanionFrame(frame)
    assert.equal(encoded.endsWith('\n'), true)
    assert.deepEqual(protocol.decodePiCompanionFrame(encoded.slice(0, -1)), frame)
  }
  assert.equal(frames[2].widgetId, 'widget-1')
  assert.equal(frames[2].event.sessionId, 'session-1')
  assert.notEqual(frames[2].widgetId, frames[2].event.sessionId)
})

test('strict directional decoders reject reflected traffic', () => {
  const line = frame => protocol.encodePiCompanionFrame(frame).trimEnd()
  assert.equal(protocol.decodeHostInboundFrame(line(frames[0])).type, 'hello')
  assert.equal(protocol.decodeHostInboundFrame(line(frames[2])).type, 'event')
  assert.equal(protocol.decodeHostInboundFrame(line(frames[7])).type, 'pong')
  assert.throws(() => protocol.decodeHostInboundFrame(line(frames[4])), /not valid/)
  assert.equal(protocol.decodeCompanionInboundFrame(line(frames[1])).type, 'welcome')
  assert.equal(protocol.decodeCompanionInboundFrame(line(frames[4])).type, 'control')
  assert.equal(protocol.decodeCompanionInboundFrame(line(frames[6])).type, 'ping')
  assert.throws(() => protocol.decodeCompanionInboundFrame(line(frames[2])), /not valid/)
})

test('incremental decoder handles split UTF-8 and multiple frames', () => {
  const decoder = new protocol.PiCompanionFrameDecoder(protocol.decodeHostInboundFrame)
  const encoded = new TextEncoder().encode(
    protocol.encodePiCompanionFrame(frames[0])
    + protocol.encodePiCompanionFrame({
      ...runtime, type: 'event', seq: 2,
      event: { type: 'assistant', phase: 'delta', text: 'héllo' },
    }),
  )
  const split = encoded.indexOf(0xc3) + 1
  assert.deepEqual(decoder.push(encoded.slice(0, split)).map(frame => frame.type), ['hello'])
  const rest = decoder.push(encoded.slice(split))
  assert.equal(rest.length, 1)
  assert.equal(rest[0].event.text, 'héllo')
  assert.deepEqual(decoder.finish(), [])
})

test('field limits use UTF-8 bytes and reject carriage-return framing ambiguity', () => {
  const base = { ...runtime, type: 'event', seq: 1 }
  const boundary = { ...base, event: { type: 'session', phase: 'info', name: '😀'.repeat(256) } }
  assert.doesNotThrow(() => protocol.encodePiCompanionFrame(boundary))
  const oversized = { ...base, event: { type: 'session', phase: 'info', name: '😀'.repeat(257) } }
  assert.throws(() => protocol.encodePiCompanionFrame(oversized), /Invalid session name/)
  const carriage = { ...base, event: { type: 'session', phase: 'info', name: 'bad\rname' } }
  assert.throws(() => protocol.encodePiCompanionFrame(carriage), /Invalid session name/)
})

test('malformed, oversized and capability-leaking frames fail closed', () => {
  const decode = value => protocol.decodePiCompanionFrame(JSON.stringify(value))
  assert.throws(() => protocol.decodePiCompanionFrame('{'), /Invalid companion JSON/)
  assert.throws(() => decode({ ...frames[0], v: 2 }), /envelope/)
  assert.throws(() => decode({ ...frames[0], token: 'short' }), /hello/)
  assert.throws(() => decode({ ...frames[2], seq: -1 }), /sequence/)
  assert.throws(() => decode({ ...frames[2], generation: 0 }), /generation/)
  assert.throws(() => decode({ ...frames[2], token }), /only valid/)
  assert.throws(() => decode({ ...runtime, type: 'control', requestId: 'x', control: { type: 'prompt', text: '' } }), /prompt/)
  assert.throws(() => decode({ ...runtime, type: 'control', requestId: 'x', control: { type: 'configure' } }), /Empty configure/)
  assert.throws(() => decode({ ...runtime, type: 'control', requestId: 'x', control: { type: 'configure', activeTools: ['read', 'read'] } }), /configure tools/)
  assert.throws(() => decode({ ...runtime, type: 'control', requestId: 'x', control: { type: 'configure', activeTools: ['read'], tool: { name: 'edit', active: true } } }), /cannot combine/)
  assert.throws(() => decode({ ...runtime, type: 'event', seq: 4, event: { type: 'catalog', models: [], thinkingLevels: ['extreme'], tools: [] } }), /thinking/)
  assert.throws(() => decode({ ...runtime, type: 'event', seq: 5, event: { type: 'queue', pending: 'yes' } }), /queue/)
  const stats = {
    type: 'stats', sessionId: 'session-1',
    tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    costUsd: 0.25, assistantMessages: 1, toolCalls: 0,
    context: { tokens: null, window: 1000, percent: null },
  }
  assert.equal(decode({ ...runtime, type: 'event', seq: 11, event: stats }).event.costUsd, 0.25)
  assert.throws(() => decode({ ...runtime, type: 'event', seq: 12, event: { ...stats, costUsd: -1 } }), /stats/)
  assert.throws(() => decode({ ...runtime, type: 'event', seq: 13, event: { ...stats, context: { tokens: 1, window: 0, percent: 1 } } }), /stats context/)
  assert.throws(() => decode({ ...runtime, type: 'event', seq: 6, event: { type: 'lifecycle', phase: 'agent_settled', runId: '', outcome: 'completed' } }), /run id/)
  assert.throws(() => decode({ ...runtime, type: 'event', seq: 7, event: { type: 'lifecycle', phase: 'agent_settled', runId: '1:1', assistantText: 'x'.repeat(65 * 1024) } }), /assistant text/)
  assert.throws(() => decode({ ...runtime, type: 'event', seq: 8, event: { type: 'tool', phase: 'end', callId: 'c', name: 'read' } }), /tool error/)
  assert.throws(() => decode({ ...runtime, type: 'event', seq: 9, event: { type: 'tool', phase: 'start', callId: 'c', name: 'read', resolvedPath: 'relative' } }), /resolved path/)
  assert.throws(() => decode({ ...runtime, type: 'event', seq: 10, event: { type: 'tool', phase: 'end', callId: 'c', name: 'read', isError: false, resolvedPath: '/tmp/a' } }), /resolved path/)
  assert.throws(() => protocol.decodePiCompanionFrame('x'.repeat(protocol.PI_COMPANION_MAX_FRAME_BYTES + 1)), /bounds/)

  const decoder = new protocol.PiCompanionFrameDecoder()
  assert.throws(
    () => decoder.push(new TextEncoder().encode('x'.repeat(protocol.PI_COMPANION_MAX_FRAME_BYTES + 1))),
    /Unterminated/,
  )
  const truncated = new protocol.PiCompanionFrameDecoder()
  truncated.push(new TextEncoder().encode(protocol.encodePiCompanionFrame(frames[0]).slice(0, -1)))
  assert.throws(() => truncated.finish(), /Truncated/)
})
