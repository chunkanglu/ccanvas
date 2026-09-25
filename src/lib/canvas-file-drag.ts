export const CANVAS_FILE_DROP_EVENT = 'ccanvas:file-drop'
export const CANVAS_FILE_DROP_TARGET = '[data-ccanvas-file-drop-target="true"]'

let suppressClickUntil = 0

function targetAt(clientX: number, clientY: number): HTMLElement | undefined {
  for (const node of document.elementsFromPoint(clientX, clientY)) {
    if (!(node instanceof HTMLElement)) continue
    const target = node.closest<HTMLElement>(CANVAS_FILE_DROP_TARGET)
    if (target) return target
  }
  return undefined
}

/**
 * WebKit's HTML drag-and-drop does not reliably start from rows inside the
 * transformed canvas. Track the pointer ourselves and dispatch only the file
 * path to an explicitly marked terminal/agent target.
 */
export function beginCanvasFileDrag(event: React.PointerEvent, path: string): void {
  if (event.button !== 0) return
  const pointerId = event.pointerId
  const originX = event.clientX
  const originY = event.clientY
  let dragging = false
  let target: HTMLElement | undefined

  const showTarget = (next?: HTMLElement) => {
    if (target === next) return
    target?.classList.remove('widget__body--drop-active')
    target = next
    target?.classList.add('widget__body--drop-active')
  }

  const cleanup = () => {
    showTarget(undefined)
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', up, true)
    window.removeEventListener('pointercancel', cancel, true)
  }

  const move = (next: PointerEvent) => {
    if (next.pointerId !== pointerId) return
    if (!dragging && Math.hypot(next.clientX - originX, next.clientY - originY) < 5) return
    dragging = true
    next.preventDefault()
    showTarget(targetAt(next.clientX, next.clientY))
  }

  const up = (next: PointerEvent) => {
    if (next.pointerId !== pointerId) return
    if (dragging) {
      next.preventDefault()
      suppressClickUntil = performance.now() + 500
      target?.dispatchEvent(new CustomEvent(CANVAS_FILE_DROP_EVENT, { detail: { path } }))
    }
    cleanup()
  }

  const cancel = (next: PointerEvent) => {
    if (next.pointerId === pointerId) cleanup()
  }

  window.addEventListener('pointermove', move, { capture: true, passive: false })
  window.addEventListener('pointerup', up, { capture: true, passive: false })
  window.addEventListener('pointercancel', cancel, true)
}

export function consumeCanvasFileDragClick(): boolean {
  if (performance.now() > suppressClickUntil) return false
  suppressClickUntil = 0
  return true
}
