import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { installApp, assertForkStopped } from '../scripts/install-app.mjs'
import { buildApp } from '../scripts/build-app.mjs'

const evidence = fileURLToPath(new URL('../.stage0/', import.meta.url))
const identity = { identifier: 'io.github.chunkanglu.ccanvas-pi', appName: 'ccanvas Pi' }
function fixture(t) {
  mkdirSync(evidence, { recursive: true })
  const root = mkdtempSync(join(evidence, 'install-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'fork.config.json'), JSON.stringify(identity))
  const applications = join(root, 'Applications')
  const source = join(root, 'built/ccanvas Pi.app')
  const destination = join(applications, 'ccanvas Pi.app')
  function bundle(path, id = identity.identifier) {
    mkdirSync(join(path, 'Contents/MacOS'), { recursive: true })
    // JSON fake plist: injected plutil reads this; no macOS commands run in tests.
    writeFileSync(join(path, 'Contents/Info.plist'), JSON.stringify({ CFBundleIdentifier: id, CFBundleExecutable: 'app' }))
    writeFileSync(join(path, 'Contents/MacOS/app'), 'synthetic executable')
  }
  bundle(source)
  const calls = []
  let processes = ''
  const run = (program, args) => {
    calls.push([program, args])
    if (program === '/usr/bin/plutil') return JSON.parse(readFileSync(args.at(-1), 'utf8'))[args[1]]
    if (program === '/bin/ps') return processes
    if (program === '/usr/bin/ditto') { cpSync(args[0], args[1], { recursive: true }); return '' }
    if (program.endsWith('/lsregister') || program === '/usr/bin/mdimport') return ''
    throw new Error(`Unexpected command: ${program}`)
  }
  return { root, applications, source, destination, bundle, calls, run, setProcesses: text => { processes = text }, platform: 'darwin' }
}

test('installs/registers the fork and removes obsolete files on rebuild', t => {
  const f = fixture(t)
  assert.equal(installApp(f), f.destination)
  writeFileSync(join(f.destination, 'obsolete-resource'), 'old')
  writeFileSync(join(f.source, 'new-resource'), 'new')
  assert.equal(installApp(f), f.destination)
  assert.equal(existsSync(join(f.destination, 'obsolete-resource')), false)
  assert.equal(readFileSync(join(f.destination, 'new-resource'), 'utf8'), 'new')
  assert.deepEqual(f.calls.filter(([p]) => p.endsWith('/lsregister')).map(([, a]) => a), [['-f', f.destination], ['-f', f.destination]])
  assert.equal(f.calls.filter(([p]) => p === '/usr/bin/mdimport').length, 2)
  assert.equal(existsSync(join(f.applications, '.ccanvas-pi-install.lock')), false)
})

test('rejects an unrelated destination without copying or changing it', t => {
  const f = fixture(t)
  f.bundle(f.destination, 'dev.ccanvas.app')
  assert.throws(() => installApp(f), /unrelated app/)
  assert.equal(f.calls.some(([p]) => p.endsWith('/ditto')), false)
  assert.match(readFileSync(join(f.destination, 'Contents/Info.plist'), 'utf8'), /dev.ccanvas.app/)
})

test('refuses running fork before build/install, never kills it', t => {
  const f = fixture(t)
  f.setProcesses(join(f.destination, 'Contents/MacOS/app'))
  assert.throws(() => assertForkStopped(f), /Quit ccanvas Pi/)
  assert.throws(() => installApp(f), /Quit ccanvas Pi/)
  assert.equal(f.calls.some(([p]) => p.endsWith('/ditto')), false)
})

test('a copy failure leaves the previous complete app untouched', t => {
  const f = fixture(t)
  f.bundle(f.destination)
  writeFileSync(join(f.destination, 'keep'), 'old')
  assert.throws(() => installApp({ ...f, run: (p, a) => {
    if (p.endsWith('/ditto')) throw new Error('simulated disk error')
    return f.run(p, a)
  } }), /simulated disk error/)
  assert.equal(readFileSync(join(f.destination, 'keep'), 'utf8'), 'old')
  assert.equal(existsSync(join(f.applications, '.ccanvas-pi-install.lock')), false)
})

test('checks for an app started while the candidate was being copied', t => {
  const f = fixture(t)
  f.bundle(f.destination)
  writeFileSync(join(f.destination, 'keep'), 'old')
  assert.throws(() => installApp({ ...f, run: (p, a) => {
    const result = f.run(p, a)
    if (p.endsWith('/ditto')) f.setProcesses(join(f.destination, 'Contents/MacOS/app'))
    return result
  } }), /Quit ccanvas Pi/)
  assert.ok(existsSync(join(f.destination, 'keep')))
})

test('refuses symlink destinations and existing installer locks', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t)
  mkdirSync(f.applications)
  symlinkSync(f.source, f.destination)
  assert.throws(() => installApp(f), /Not a regular app bundle/)
  rmSync(f.destination)
  mkdirSync(join(f.applications, '.ccanvas-pi-install.lock'))
  assert.throws(() => installApp(f), /Another install is active/)
  assert.ok(existsSync(f.source))
})

test('Launch Services failure clearly distinguishes installation from registration', t => {
  const f = fixture(t)
  assert.throws(() => installApp({ ...f, run: (p, a) => {
    if (p.endsWith('/lsregister')) throw new Error('registration unavailable')
    return f.run(p, a)
  } }), /App installed.*registration failed/)
  assert.ok(existsSync(join(f.destination, 'Contents/MacOS/app')))
})

test('build failure and stale successful build never install a previous artifact', t => {
  const f = fixture(t)
  let installs = 0
  const opts = { ...f, args: ['--debug'], env: {}, checkStopped() {}, log() {}, install: () => { installs++ } }
  assert.throws(() => buildApp({ ...opts, run: () => ({ status: 1 }) }), /installation was not attempted/)
  const artifact = join(f.root, 'src-tauri/target/debug/bundle/macos/ccanvas Pi.app')
  f.bundle(artifact)
  assert.throws(() => buildApp({ ...opts, run: () => ({ status: 0 }) }), /stale app/)
  assert.equal(installs, 0)
})

test('successful debug/release builds install their exact fresh artifact', t => {
  const f = fixture(t)
  for (const profile of ['debug', 'release']) {
    const artifact = join(f.root, `src-tauri/target/${profile}/bundle/macos/ccanvas Pi.app`)
    buildApp({
      root: f.root, platform: 'darwin', args: profile === 'debug' ? ['--debug'] : [], env: {},
      checkStopped() {}, log() {},
      run: (_cmd, args, options) => {
        assert.ok(args.includes('--no-sign'))
        assert.ok(args.includes('--offline'))
        assert.ok(args.includes('--locked'))
        assert.equal(options.env.CARGO_TARGET_DIR, join(f.root, 'src-tauri/target'))
        f.bundle(artifact)
        return { status: 0 }
      },
      install: ({ source }) => { assert.equal(source, artifact); return f.destination },
    })
  }
})

test('CI, opt-out and non-macOS builds skip install and running-app checks', t => {
  const f = fixture(t)
  const base = {
    root: f.root, args: [], log() {}, run: () => ({ status: 0 }),
    checkStopped: () => assert.fail('must not require the installed app to stop'),
    install: () => assert.fail('must not install'),
  }
  buildApp({ ...base, platform: 'darwin', env: { CI: 'true' } })
  buildApp({ ...base, platform: 'darwin', env: { CCANVAS_SKIP_APP_INSTALL: '1' } })
  buildApp({ ...base, platform: 'linux', env: {} })
  assert.throws(() => buildApp({ ...base, args: ['--target', 'other'], env: {} }), /Usage:/)
  assert.throws(() => buildApp({ ...base, env: { CARGO_BUILD_TARGET: 'other' } }), /Custom Cargo targets/)
})
