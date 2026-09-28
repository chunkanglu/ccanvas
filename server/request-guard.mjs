// Authentication for the optional local web backend. The backend can run
// programs, read/write files, and open shells, so every capability-bearing
// route requires a per-start random token. Host checks block DNS rebinding;
// CORS is reflected only to fork UI origins, never `*`.
import { randomBytes, timingSafeEqual } from 'node:crypto'

export const TOKEN_HEADER = 'x-ccanvas-token'

export function createBackendToken() {
  return randomBytes(32).toString('base64url')
}

export function allowedOrigins(config) {
  const ports = [config.devPort, config.previewPort]
  return new Set([
    ...ports.flatMap(port => [`http://127.0.0.1:${port}`, `http://localhost:${port}`]),
    // Tauri desktop webviews (macOS/Linux and Windows).
    'tauri://localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
  ])
}

function sameToken(candidate, token) {
  if (typeof candidate !== 'string' || candidate.length !== token.length) return false
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(token))
}

/** Only numeric loopback and localhost on the configured port are served. */
export function validHost(host, port) {
  return typeof host === 'string'
    && [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase())
}

export function createBackendGuard({ port, token, origins }) {
  const allowed = origins instanceof Set ? origins : new Set(origins)

  const originAllowed = origin => origin === undefined || allowed.has(origin)

  const corsHeaders = origin => allowed.has(origin)
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': `Content-Type, ${TOKEN_HEADER}`,
        Vary: 'Origin',
      }
    : { Vary: 'Origin' }

  /**
   * Authorize an HTTP request. Media/iframe callers cannot set headers, so the
   * same capability may be supplied as `token` in the query string.
   */
  const checkHttp = (req, url) => {
    if (!validHost(req.headers.host, port)) return { ok: false, status: 421, error: 'invalid host' }
    const origin = req.headers.origin
    if (!originAllowed(origin)) return { ok: false, status: 403, error: 'origin not allowed' }
    if (req.method === 'OPTIONS') return { ok: true, preflight: true }
    // Liveness only; no filesystem or identity data is disclosed.
    if (url.pathname === '/health' && !req.headers[TOKEN_HEADER] && !url.searchParams.has('token')) {
      return { ok: true, publicHealth: true }
    }
    const supplied = req.headers[TOKEN_HEADER] ?? url.searchParams.get('token')
    if (!sameToken(supplied, token)) return { ok: false, status: 401, error: 'pairing token required' }
    return { ok: true }
  }

  /** Browsers always send Origin for WebSockets; require an allowed one plus the token. */
  const checkUpgrade = (req, url) => {
    if (!validHost(req.headers.host, port)) return false
    if (!req.headers.origin || !allowed.has(req.headers.origin)) return false
    return sameToken(url.searchParams.get('token'), token)
  }

  return { corsHeaders, checkHttp, checkUpgrade }
}
