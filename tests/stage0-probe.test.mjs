import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const result = await build({
  root, configFile: false, logLevel: 'silent',
  build: {
    write: false, minify: false,
    lib: { entry: `${root}scripts/pi-tui-probe-extension.ts`, formats: ['es'] },
    rollupOptions: { external: ['node:fs'] },
  },
})
const bundle = result[0].output.find(e => e.type === 'chunk' && e.isEntry)
const { default: extension } = await import(`data:text/javascript;base64,${Buffer.from(bundle.code).toString('base64')}`)

// The optional PTY probe is POSIX-only. Normal isolation checks run on Windows too.
test('TUI probe is metadata-only, refuses model input and cleans up on replacement', { skip: process.platform === 'win32' }, async () => {
  mkdirSync(`${root}.stage0`, { recursive: true })
  const dir = mkdtempSync(`${root}.stage0/probe-unit-`)
  const envKeys = ['CCANVAS_PROBE_LOG', 'CCANVAS_PROBE_SESSION']
  const saved = Object.fromEntries(envKeys.map(k => [k, process.env[k]]))
  const events = new Map(), commands = new Map()
  const api = {
    on: (name, fn) => events.set(name, fn),
    registerCommand: (name, def) => commands.set(name, def),
    getActiveTools: () => ['read'],
    getCommands: () => [{ name: 'yaks', source: 'extension' }, { name: 'test-skill', source: 'skill' }],
  }
  try {
    delete process.env.CCANVAS_PROBE_LOG
    delete process.env.CCANVAS_PROBE_SESSION
    assert.throws(() => extension(api), /Use scripts\/probe-pi-tui.py/)
    const log = `${dir}/events.jsonl`
    process.env.CCANVAS_PROBE_LOG = log
    process.env.CCANVAS_PROBE_SESSION = `${dir}/synthetic.jsonl`
    writeFileSync(log, '', { mode: 0o600 })
    chmodSync(log, 0o644)
    assert.throws(() => extension(api), /private regular file/)
    chmodSync(log, 0o600)
    extension(api)
    const ui = {
      confirm: async () => false,
      custom: async factory => new Promise(resolve => {
        const component = factory({}, {}, { matches: (key, name) => key === '\x1b' && name === 'tui.select.cancel' }, resolve)
        assert.ok(component.render(5).every(line => line.length <= 5))
        component.handleInput('\x1b')
      }),
    }
    const ctx = {
      mode: 'tui', hasUI: true, ui,
      sessionManager: { getSessionId: () => 'synthetic', getBranch: () => [] },
    }
    events.get('session_start')({ reason: 'startup' }, ctx)
    const command = commands.get('ccanvas-probe').handler
    await command('snapshot', ctx)
    await command('custom', ctx)
    await command('confirm', ctx)
    assert.deepEqual(events.get('input')({ text: 'Do not invoke a model' }), { action: 'handled' })
    assert.equal(ctx.ui, ui, 'probe must not patch the installed UI stack')
    events.get('session_shutdown')({ reason: 'resume' })
    events.get('session_shutdown')({ reason: 'resume' }) // idempotent cleanup
    const records = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(records.map(r => r.type), [
      'session_start', 'snapshot', 'custom_open', 'custom_result',
      'confirm_open', 'confirm_result', 'unexpected_input', 'session_shutdown',
    ])
    assert.deepEqual(records[0].commands, ['yaks'])
    assert.equal(records.find(r => r.type === 'custom_result').result, 'cancelled')
    assert.equal(records.find(r => r.type === 'confirm_result').result, false)
    assert.ok(!readFileSync(log, 'utf8').includes('Do not invoke a model'), 'input bodies must not be logged')
  } finally {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
