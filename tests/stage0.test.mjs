import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = new URL('../', import.meta.url)
const text = (path) => readFile(new URL(path, root), 'utf8')
const json = async (path) => JSON.parse(await text(path))
const fork = await json('fork.config.json')
const tauri = await json('src-tauri/tauri.conf.json')

// Use the already-installed Vite library API, not an additional test dependency.
const result = await build({
  configFile: false,
  root: fileURLToPath(root),
  logLevel: 'silent',
  build: {
    write: false,
    minify: false,
    lib: { entry: fileURLToPath(new URL('src/lib/persistence.ts', root)), formats: ['es'] },
  },
})
const bundle = result[0].output.find((entry) => entry.type === 'chunk' && entry.isEntry)
const persistence = await import(`data:text/javascript;base64,${Buffer.from(bundle.code).toString('base64')}`)

class MemoryStorage {
  data = new Map()
  getItem(key) { return this.data.get(key) ?? null }
  setItem(key, value) { this.data.set(key, String(value)) }
  removeItem(key) { this.data.delete(key) }
}

test('fork identity is isolated and Tauri/dev configuration agrees', async () => {
  assert.equal(tauri.productName, fork.appName)
  assert.equal(tauri.app.windows[0].title, fork.appName)
  assert.equal(tauri.identifier, fork.identifier)
  assert.notEqual(tauri.identifier, 'dev.ccanvas.app')
  assert.equal(tauri.build.devUrl, `http://127.0.0.1:${fork.devPort}`)
  assert.match(await text('index.html'), /<title>ccanvas Pi<\/title>/)
  assert.match(await text('vite.config.ts'), /port: fork.devPort/)
  assert.match(await text('vite.config.ts'), /port: fork.previewPort, strictPort: true/)
  assert.equal(new Set([fork.devPort, fork.previewPort, fork.backendPort]).size, 3)
  for (const port of [fork.devPort, fork.previewPort, fork.backendPort]) {
    assert.ok(Number.isInteger(port) && port > 1024 && port < 65536)
    assert.ok(![5173, 4173, 7531].includes(port))
  }
})

test('HTTP, WebSocket and server use the same fork backend configuration', async () => {
  assert.match(await text('src/lib/fork.ts'), /http:\/\/127\.0\.0\.1:\$\{config.backendPort\}/)
  assert.match(await text('src/lib/fork.ts'), /ws:\/\/127\.0\.0\.1:\$\{config.backendPort\}/)
  assert.match(await text('src/lib/backend.ts'), /const BASE = BACKEND_HTTP_URL/)
  assert.match(await text('src/lib/terminal.ts'), /const WS_URL = BACKEND_WS_URL/)
  assert.match(await text('server/pty-server.mjs'), /const PORT = fork.backendPort/)
})

test('upstream autosave, templates and prompts are neither restored nor overwritten', () => {
  const storage = new MemoryStorage()
  globalThis.localStorage = storage
  const upstream = {
    'ccanvas:session:v1': '{"tabs":[{"id":"upstream"}]}',
    'ccanvas:templates:v1': '[{"id":"upstream-template"}]',
    'ccanvas:prompts:v1': '[{"id":"upstream-prompt"}]',
  }
  for (const [key, value] of Object.entries(upstream)) storage.setItem(key, value)
  assert.equal(persistence.loadSession(), null)
  assert.deepEqual(persistence.loadTemplates(), [])
  assert.deepEqual(persistence.loadPrompts(), [])
  const session = { tabs: [{ id: 'fork-tab' }], activeTabId: 'fork-tab' }
  persistence.saveSession(session)
  persistence.saveTemplates([{ id: 'fork-template', name: 'Example', widgets: [] }])
  persistence.savePrompts([{ id: 'fork-prompt', name: 'Example', text: 'Hello' }])
  assert.deepEqual(persistence.loadSession(), session)
  assert.equal(persistence.loadTemplates()[0].id, 'fork-template')
  assert.equal(persistence.loadPrompts()[0].id, 'fork-prompt')
  for (const [key, value] of Object.entries(upstream)) assert.equal(storage.getItem(key), value)
  for (const name of ['session:v1', 'templates:v1', 'prompts:v1']) {
    assert.notEqual(storage.getItem(`${fork.storageNamespace}:${name}`), null)
  }
  delete globalThis.localStorage
})

test('stage 0 preserves v1 canvas semantics rather than migrating agents', async () => {
  const fixture = await json('tests/fixtures/workspace-v1.ccnvs')
  const restored = persistence.fromFile(fixture, 'fallback')
  assert.deepEqual(persistence.toFile(restored), fixture)
  assert.equal(restored.elements[0].sessionId, fixture.elements[0].sessionId)
  assert.equal(restored.elements[1].agentId, fixture.elements[0].id)
})

test('checkpoint metadata/refs and usage preference are fork-scoped', async () => {
  assert.notEqual(fork.storageNamespace, 'ccanvas')
  assert.notEqual(fork.checkpointRefPrefix, 'refs/ccanvas/cp')
  const checkpoints = await text('src/lib/checkpoints.ts')
  assert.match(checkpoints, /storageKey\('checkpoints:v1'\)/)
  assert.match(checkpoints, /\$\{CHECKPOINT_REF_PREFIX\}\/\$\{id\}/)
  assert.match(checkpoints, /\$\{CHECKPOINT_REF_PREFIX\}\/\$\{cp.id\}/)
  assert.match(await text('src/ui/UsagePill.tsx'), /storageKey\('usageLimit'\)/)
})

test('fork releases are manual, fork-tagged draft prereleases', async () => {
  const workflow = await text('.github/workflows/release.yml')
  assert.doesNotMatch(workflow, /^  push:/m)
  assert.match(workflow, /github.repository == 'chunkanglu\/ccanvas'/)
  assert.match(workflow, /startsWith\(inputs.tag, 'pi-v'\)/)
  assert.match(workflow, /ref: \$\{\{ inputs.tag \}\}/)
  assert.match(workflow, /releaseDraft: true/)
  assert.match(workflow, /prerelease: true/)
})

test('Pi launcher records the requested environment without changing agent default', async () => {
  assert.equal(fork.piLauncher.program, 'pi')
  assert.deepEqual(fork.piLauncher.env, { PI_TOOLS_IDLE_TIMEOUT_MS: '6000000' })
  assert.match(await text('src/widgets/TerminalBody.tsx'), /claude --resume/)
})
