import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const result = await build({
  root, configFile: false, logLevel: 'silent',
  build: {
    write: false, minify: false,
    lib: { entry: `${root}src/lib/pi-agent-ux.ts`, formats: ['es'] },
  },
})
const bundle = result[0].output.find(entry => entry.type === 'chunk' && entry.isEntry)
const ux = await import(`data:text/javascript;base64,${Buffer.from(bundle.code).toString('base64')}`)

const transcriptResult = await build({
  root, configFile: false, logLevel: 'silent',
  build: {
    write: false, minify: false,
    lib: { entry: `${root}src/lib/transcript.ts`, formats: ['es'] },
  },
})
const transcriptBundle = transcriptResult[0].output.find(entry => entry.type === 'chunk' && entry.isEntry)
const transcript = await import(`data:text/javascript;base64,${Buffer.from(transcriptBundle.code).toString('base64')}`)

test('Pi draft stays editable and acknowledgement never erases newer text', () => {
  assert.equal(ux.appendPiDraft('review: ', 'the change'), 'review: the change')
  assert.equal(ux.normalizedPiDraft('first\r\nsecond\n'), 'first\nsecond')
  assert.equal(ux.draftAfterAcknowledgement('sent text', 'sent text'), '')
  assert.equal(
    ux.draftAfterAcknowledgement('sent text plus a new thought', 'sent text'),
    'sent text plus a new thought',
  )
})


test('agent file drops are captured before xterm and routed to the Pi draft', async () => {
  const source = await readFile(join(root, 'src/widgets/WidgetFrame.tsx'), 'utf8')
  assert.match(source, /onDragOverCapture=\{isTerminal \? onBodyDragOver/)
  assert.match(source, /onDropCapture=\{isTerminal \? onBodyDrop/)
  assert.match(source, /data-ccanvas-file-drop-target=\{isTerminal/)
  assert.match(source, /CANVAS_FILE_DROP_EVENT/)
  assert.match(source, /el\.harness === 'pi'[\s\S]*sendPrompt\(sessionId,[\s\S]*false\)/)
  const fileTree = await readFile(join(root, 'src/widgets/FilesBody.tsx'), 'utf8')
  assert.match(fileTree, /beginCanvasFileDrag\(event, path\)/)
  const diff = await readFile(join(root, 'src/widgets/DiffBody.tsx'), 'utf8')
  assert.match(diff, /beginCanvasFileDrag\(event, resolvePath\(cwd, f\.path\)\)/)
})

test('Pi transcript follows only the active branch and does not materialize compaction tails', () => {
  const entries = [
    { type: 'session', version: 3, id: 'session-id' },
    { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'root request' } },
    { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'root reply' }] } },
    { type: 'message', id: 'old-u', parentId: 'a1', message: { role: 'user', content: 'abandoned request' } },
    { type: 'message', id: 'old-a', parentId: 'old-u', message: { role: 'assistant', content: [{ type: 'text', text: 'abandoned reply' }] } },
    { type: 'message', id: 'u2', parentId: 'a1', message: { role: 'user', content: 'active request' } },
    {
      type: 'message', id: 'a2', parentId: 'u2',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'active reply' },
          { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/tmp/example' } },
        ],
      },
    },
    {
      type: 'compaction', id: 'compact', parentId: 'a2', summary: 'active summary', tokensBefore: 1200,
      retainedTail: [{ role: 'user', content: 'must not duplicate' }],
    },
    { type: 'session_info', id: 'info', parentId: 'compact', name: 'active branch' },
  ]
  const parsed = transcript.parsePiTranscript(`${entries.map(JSON.stringify).join('\n')}\n`)
  assert.equal(parsed.activeEntries, 6)
  assert.equal(parsed.parsedEntries, 8)
  assert.equal(parsed.truncated, false)
  assert.deepEqual(parsed.turns.map(turn => turn.text), [
    'root request', 'root reply', 'active request', 'active reply', 'active summary',
  ])
  assert.deepEqual(parsed.turns[3].tools, [{ name: 'read', target: '/tmp/example' }])
  assert.equal(JSON.stringify(parsed.turns).includes('abandoned'), false)
  assert.equal(JSON.stringify(parsed.turns).includes('must not duplicate'), false)

  const selectedOldBranch = transcript.parsePiTranscript(
    `${entries.map(JSON.stringify).join('\n')}\n`,
    'old-a',
  )
  assert.deepEqual(selectedOldBranch.turns.map(turn => turn.text), [
    'root request', 'root reply', 'abandoned request', 'abandoned reply',
  ])
})
