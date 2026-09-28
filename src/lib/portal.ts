import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

// Native web portals are real WebKit views drawn over the HTML canvas (see
// src-tauri/src/portal.rs). They cannot be transformed or stacked by CSS, so a
// DOM "hole" reports where the view belongs and whether anything covers it.

export type PortalRect = { x: number; y: number; width: number; height: number }
export type PortalPlacement = PortalRect & { visible: boolean; zoom: number }
export type PortalState = { id: string; url?: string; title?: string; loading?: boolean }

const HIDDEN: PortalPlacement = { x: 0, y: 0, width: 0, height: 0, visible: false, zoom: 1 }

/**
 * Decide whether the native view may be shown. The view always draws above the
 * DOM, so it is shown only when the entire hole is on-screen and every sample
 * point hits the hole itself — any menu, dialog, dock panel or higher widget
 * covering it hides the native view instead of being drawn over.
 */
export function portalPlacement(
  rect: PortalRect,
  layoutWidth: number,
  viewport: { width: number; height: number },
  hitsHole: (x: number, y: number) => boolean,
): PortalPlacement {
  if (!(rect.width > 1 && rect.height > 1)) return HIDDEN
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > viewport.width || rect.y + rect.height > viewport.height) {
    return HIDDEN
  }
  // Inset past widget chrome such as the 16px resize grip in the corner.
  const inset = Math.min(24, rect.width / 4, rect.height / 4)
  const columns = 4
  const rows = 4
  for (let column = 0; column < columns; column++) {
    for (let row = 0; row < rows; row++) {
      const x = rect.x + inset + ((rect.width - inset * 2) * column) / (columns - 1)
      const y = rect.y + inset + ((rect.height - inset * 2) * row) / (rows - 1)
      if (!hitsHole(x, y)) return HIDDEN
    }
  }
  if (!hitsHole(rect.x + rect.width / 2, rect.y + rect.height / 2)) return HIDDEN
  // Measured scale, not the camera value, so any ancestor transform is honored.
  const zoom = layoutWidth > 0 ? rect.width / layoutWidth : 1
  return { ...rect, visible: true, zoom }
}

export function samePlacement(a: PortalPlacement | null, b: PortalPlacement): boolean {
  if (!a || a.visible !== b.visible) return false
  if (!b.visible) return true
  return Math.round(a.x) === Math.round(b.x)
    && Math.round(a.y) === Math.round(b.y)
    && Math.round(a.width) === Math.round(b.width)
    && Math.round(a.height) === Math.round(b.height)
    && Math.abs(a.zoom - b.zoom) < 0.005
}

export const openPortal = (id: string, url: string) => invoke<void>('portal_open', { id, url })
export const placePortal = (id: string, bounds: PortalPlacement) =>
  invoke<void>('portal_bounds', { id, bounds })
export const navigatePortal = (id: string, url: string) => invoke<void>('portal_navigate', { id, url })
export const portalAction = (id: string, action: 'back' | 'forward' | 'reload' | 'focus') =>
  invoke<void>('portal_action', { id, action })
export const closePortal = (id: string) => invoke<void>('portal_close', { id })

export function onPortalState(handler: (state: PortalState) => void): Promise<UnlistenFn> {
  return listen<PortalState>('portal:state', event => handler(event.payload))
}
