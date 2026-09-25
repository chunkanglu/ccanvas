import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('../', import.meta.url))
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const execute = (program, args) => execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const entryExists = path => {
  try { lstatSync(path); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

export function assertForkStopped({ root = ROOT, applications = join(homedir(), 'Applications'), run = execute } = {}) {
  const processes = run('/bin/ps', ['-axww', '-o', 'comm=']).split('\n').map(s => s.trim())
  const installed = join(resolve(applications), 'ccanvas Pi.app/Contents/MacOS/')
  const target = join(root, 'src-tauri/target')
  if (processes.some(p => p.startsWith(installed) || ['debug', 'release'].some(profile =>
    p === join(target, profile, 'app') || p.startsWith(join(target, profile, 'bundle/macos/ccanvas Pi.app/Contents/MacOS/'))))) {
    throw new Error('Quit ccanvas Pi, then rerun the build/install command. No running app was replaced.')
  }
}

/** Install a complete bundle, never merge files into an existing app. */
export function installApp({
  source, root = ROOT, applications = join(homedir(), 'Applications'),
  platform = process.platform, run = execute,
} = {}) {
  if (platform !== 'darwin') throw new Error('Local app installation is macOS-only.')
  const config = JSON.parse(readFileSync(join(root, 'fork.config.json'), 'utf8'))
  if (config.identifier !== 'io.github.chunkanglu.ccanvas-pi' || config.appName !== 'ccanvas Pi') {
    throw new Error('Installer is restricted to the ccanvas Pi fork identity.')
  }
  source = resolve(source ?? join(root, 'src-tauri/target/debug/bundle/macos/ccanvas Pi.app'))
  const destination = join(resolve(applications), `${config.appName}.app`)
  if (source === destination) throw new Error('Source and installation destination must differ.')

  function inspect(bundle) {
    const stat = lstatSync(bundle)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Not a regular app bundle: ${bundle}`)
    const plist = join(bundle, 'Contents/Info.plist')
    const field = name => run('/usr/bin/plutil', ['-extract', name, 'raw', '-o', '-', plist]).trim()
    if (field('CFBundleIdentifier') !== config.identifier) throw new Error(`Refusing unrelated app: ${bundle}`)
    const executable = field('CFBundleExecutable')
    if (!executable || basename(executable) !== executable || executable === '.' || executable === '..') {
      throw new Error('Invalid bundle executable name.')
    }
    const binary = join(bundle, 'Contents/MacOS', executable)
    if (!lstatSync(binary).isFile()) throw new Error('App bundle has no executable file.')
    return binary
  }
  const sourceBinary = inspect(source)
  function assertStopped() {
    // Fail closed if process enumeration fails. Never kill or quit user sessions.
    const processes = run('/bin/ps', ['-axww', '-o', 'comm=']).split('\n').map(s => s.trim())
    if (processes.some(p => p === sourceBinary || p.startsWith(`${destination}/Contents/MacOS/`))) {
      throw new Error('Quit ccanvas Pi, then rerun the build/install command. No running app was replaced.')
    }
  }
  assertStopped()
  mkdirSync(applications, { recursive: true })
  if (lstatSync(applications).isSymbolicLink()) throw new Error('Applications directory must not be a symlink.')
  const lock = join(applications, '.ccanvas-pi-install.lock')
  try { mkdirSync(lock) } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another install is active, or an interrupted install left ${lock}. Inspect before removing it.`)
    throw error
  }
  let stage, preserveStage = false
  try {
    if (entryExists(destination)) inspect(destination)
    stage = mkdtempSync(join(applications, '.ccanvas-pi-install-'))
    const candidate = join(stage, `${config.appName}.app`)
    const previous = join(stage, 'previous.app')
    run('/usr/bin/ditto', [source, candidate])
    inspect(candidate)
    assertStopped()
    let hadPrevious = false
    if (entryExists(destination)) {
      inspect(destination) // Recheck after the copy, before moving anything.
      renameSync(destination, previous)
      hadPrevious = true
    }
    try {
      renameSync(candidate, destination)
    } catch (error) {
      if (hadPrevious) {
        try { renameSync(previous, destination) } catch (restoreError) {
          preserveStage = true
          throw new Error(`Replacement and rollback failed. Previous app retained at ${previous}: ${restoreError.message}`, { cause: error })
        }
      }
      throw error
    }
    // The new app is now installed. Registration failure is reported explicitly,
    // not disguised as a failed build or a completed Spotlight registration.
    try { run(LSREGISTER, ['-f', destination]) } catch (error) {
      throw new Error(`App installed at ${destination}, but Launch Services registration failed: ${error.message}`)
    }
    try { run('/usr/bin/mdimport', [destination]) } catch (error) {
      throw new Error(`App installed and registered at ${destination}, but Spotlight indexing request failed: ${error.message}`)
    }
    return destination
  } finally {
    if (stage && !preserveStage) rmSync(stage, { recursive: true, force: true })
    rmSync(lock, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: node scripts/install-app.mjs [bundle-path]')
    console.log(`Installed and registered: ${installApp({ source: process.argv[2] })}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
