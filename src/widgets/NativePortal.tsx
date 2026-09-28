import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import {
  closePortal,
  navigatePortal,
  onPortalState,
  openPortal,
  placePortal,
  portalAction,
  portalPlacement,
  samePlacement,
  type PortalPlacement,
  type PortalState,
} from '../lib/portal'

const OCCLUSION_INTERVAL_MS = 120

/**
 * A transparent hole the native WebKit portal is drawn over. The hole measures
 * itself every frame (pan/zoom/drag/resize all move it) and re-samples what is
 * on top of it periodically, then sends placement only when it changed.
 */
export type NativePortalHandle = { action: (action: 'back' | 'forward' | 'reload') => void }

export const NativePortal = forwardRef<NativePortalHandle, {
  url: string
  onState: (state: PortalState) => void
}>(function NativePortal({ url, onState }, ref) {
  const holeRef = useRef<HTMLDivElement>(null)
  // One native view per mounted widget instance (duplicate canvases differ).
  const idRef = useRef(`portal:${crypto.randomUUID()}`)
  const onStateRef = useRef(onState)
  onStateRef.current = onState
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string>()
  const [shown, setShown] = useState(false)
  const navigated = useRef(url)
  useImperativeHandle(ref, () => ({
    action: action => { void portalAction(idRef.current, action).catch(() => {}) },
  }), [])

  useEffect(() => {
    const id = idRef.current
    let alive = true
    let unlisten: (() => void) | undefined
    void onPortalState(state => {
      if (state.id !== id) return
      // In-page navigation/redirects are already where the view is; recording
      // them prevents persisting the URL from triggering a reload loop.
      if (state.url) navigated.current = state.url
      onStateRef.current(state)
    }).then(off => {
      if (alive) unlisten = off
      else off()
    })
    openPortal(id, url)
      .then(() => { if (alive) setReady(true) })
      .catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => {
      alive = false
      unlisten?.()
      void closePortal(id).catch(() => {})
    }
    // The initial URL opens the view; later changes navigate it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!ready || url === navigated.current) return
    navigated.current = url
    navigatePortal(idRef.current, url).catch(reason => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [ready, url])

  useEffect(() => {
    if (!ready) return
    const id = idRef.current
    let frame = 0
    let last: PortalPlacement | null = null
    let lastRect = ''
    let lastSample = 0
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick)
      const hole = holeRef.current
      if (!hole) return
      const box = hole.getBoundingClientRect()
      const key = `${box.x},${box.y},${box.width},${box.height}`
      if (key === lastRect && now - lastSample < OCCLUSION_INTERVAL_MS) return
      lastRect = key
      lastSample = now
      const next = portalPlacement(
        { x: box.x, y: box.y, width: box.width, height: box.height },
        hole.offsetWidth,
        { width: window.innerWidth, height: window.innerHeight },
        (x, y) => {
          const top = document.elementFromPoint(x, y)
          return !!top && (top === hole || hole.contains(top))
        },
      )
      if (samePlacement(last, next)) return
      last = next
      setShown(next.visible)
      void placePortal(id, next).catch(() => {})
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      void placePortal(id, { x: 0, y: 0, width: 0, height: 0, visible: false, zoom: 1 }).catch(() => {})
    }
  }, [ready])

  return (
    <div ref={holeRef} className="web__portal" style={{ pointerEvents: 'auto' }}>
      {!shown && (
        <div className="web__portal-msg">
          {error
            ? <>portal unavailable: {error}</>
            : ready
              ? <>page hidden while covered or partly off-screen</>
              : <>opening native browser view…</>}
        </div>
      )}
    </div>
  )
})
