import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const result = await build({
  root, configFile: false, logLevel: 'silent',
  build: { write: false, minify: false, lib: { entry: `${root}tests/fixtures/portal-entry.ts`, formats: ['es'] } },
})
const bundle = result[0].output.find(entry => entry.type === 'chunk' && entry.isEntry)
const portal = await import(`data:text/javascript;base64,${Buffer.from(bundle.code).toString('base64')}`)
const viewport = { width: 1400, height: 900 }
const rect = { x: 100, y: 120, width: 640, height: 400 }
const always = () => true

test('portal placement follows the hole and measured canvas scale', () => {
  const placement = portal.portalPlacement(rect, 800, viewport, always)
  assert.deepEqual(placement, { ...rect, visible: true, zoom: 0.8 })
  assert.equal(portal.portalPlacement(rect, 640, viewport, always).zoom, 1)
})

test('portal hides when partly off-screen, degenerate, or covered anywhere', () => {
  assert.equal(portal.portalPlacement({ ...rect, x: -10 }, 640, viewport, always).visible, false)
  assert.equal(portal.portalPlacement({ ...rect, y: 700 }, 640, viewport, always).visible, false)
  assert.equal(portal.portalPlacement({ ...rect, width: 0 }, 640, viewport, always).visible, false)
  // A context menu over the lower-right quarter.
  const menu = (x, y) => !(x > 500 && y > 400)
  assert.equal(portal.portalPlacement(rect, 640, viewport, menu).visible, false)
  // Samples stay inside the resize-grip inset, so corner chrome does not hide it.
  const grip = (x, y) => !(x > rect.x + rect.width - 16 && y > rect.y + rect.height - 16)
  assert.equal(portal.portalPlacement(rect, 640, viewport, grip).visible, true)
})

test('placement updates are deduplicated at pixel and zoom precision', () => {
  const a = portal.portalPlacement(rect, 640, viewport, always)
  assert.equal(portal.samePlacement(null, a), false)
  assert.equal(portal.samePlacement(a, { ...a, x: a.x + 0.2 }), true)
  assert.equal(portal.samePlacement(a, { ...a, x: a.x + 1 }), false)
  assert.equal(portal.samePlacement(a, { ...a, zoom: a.zoom + 0.01 }), false)
  const hidden = { x: 0, y: 0, width: 0, height: 0, visible: false, zoom: 1 }
  assert.equal(portal.samePlacement(hidden, { ...hidden, x: 5 }), true)
})

test('desktop URLs use native portals and native security policy', async () => {
  const [web, frame, native, rust, cargo, lib, caps] = await Promise.all([
    'src/widgets/WebBody.tsx', 'src/widgets/WidgetFrame.tsx', 'src/widgets/NativePortal.tsx',
    'src-tauri/src/portal.rs', 'src-tauri/Cargo.toml', 'src-tauri/src/lib.rs', 'src-tauri/capabilities/default.json',
  ].map(path => readFile(`${root}${path}`, 'utf8')))
  assert.match(web, /const nativePortal = isTauri\(\) && !fileMode/)
  assert.match(web, /<NativePortal ref=\{portalRef\} url=\{src\}/)
  assert.match(frame, /nativePortal \|\|/)
  assert.match(native, /if \(state\.url\) navigated\.current = state\.url/)
  assert.match(native, /void closePortal\(id\)/)
  assert.match(rust, /\.on_navigation\(move \|url\| allowed_portal_url/)
  assert.match(rust, /NewWindowResponse::Deny/)
  assert.match(cargo, /features = \["protocol-asset", "unstable"\]/)
  assert.match(lib, /portal::portal_open/)
  // No remote capability: Tauri rejects portal-origin IPC to app commands/plugins.
  assert.doesNotMatch(caps, /"remote"/)
})
