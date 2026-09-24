import { spawnSync } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertForkStopped, installApp, ROOT } from './install-app.mjs'

/** Local rebuild entrypoint. CI/release bundling still uses Tauri directly. */
export function buildApp({
  args = process.argv.slice(2), platform = process.platform, env = process.env,
  root = ROOT, run = spawnSync, install = installApp, checkStopped = assertForkStopped,
  log = console.log,
} = {}) {
  if (args.some(arg => arg !== '--debug') || args.length > 1) {
    throw new Error('Usage: npm run app:build [-- --debug]. For other Tauri flags use npm run app:bundle -- ...')
  }
  if (env.CARGO_BUILD_TARGET) throw new Error('Custom Cargo targets require npm run app:bundle; automatic installation uses the native layout.')
  const localMac = platform === 'darwin' && !env.CI && env.CCANVAS_SKIP_APP_INSTALL !== '1'
  // A build that explicitly skips installation must not care whether the
  // separately installed app is running.
  if (localMac) checkStopped({ root })
  const profile = args.includes('--debug') ? 'debug' : 'release'
  const source = join(root, `src-tauri/target/${profile}/bundle/macos/ccanvas Pi.app`)
  const fingerprint = () => {
    try {
      const s = lstatSync(join(source, 'Contents/Info.plist'), { bigint: true })
      return `${s.dev}:${s.ino}:${s.mtimeNs}:${s.ctimeNs}`
    } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  const before = localMac ? fingerprint() : null
  const tauriArgs = ['build', '--ci', ...args]
  if (platform === 'darwin') tauriArgs.push('--bundles', 'app', '--no-sign')
  tauriArgs.push('--', '--offline', '--locked')
  const result = run(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), ...tauriArgs], {
    cwd: root, env: { ...env, CARGO_NET_OFFLINE: 'true', CARGO_TARGET_DIR: join(root, 'src-tauri/target') }, stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`App build failed (${result.signal ?? result.status}); installation was not attempted.`)
  if (!localMac) {
    log('Build finished. Local installation skipped (non-macOS, CI, or CCANVAS_SKIP_APP_INSTALL=1).')
    return
  }
  // Exact, freshly bundled artifact: no newest-file guesses or stale fallback.
  const after = fingerprint()
  if (!after || after === before) throw new Error('Build produced no fresh bundle at the expected path; refusing to install a stale app.')
  const destination = install({ source, root })
  log(`Installed and registered: ${destination}\nLaunch with Spotlight: ccanvas Pi`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { buildApp() } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
