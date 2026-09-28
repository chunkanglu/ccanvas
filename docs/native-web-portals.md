# Native web portals

## Status

Implemented on `fork/native-web-portals`; installed-app acceptance pending.

## Why

The web widget was an `<iframe>`. In the desktop app, sites that forbid framing (`X-Frame-Options`, CSP `frame-ancestors`) stayed blank, and non-localhost `http://` pages were blocked as mixed content. The optional proxy handled only simple pages. Logged-in apps need a real browser view.

## Design

The approach matches Maestri, whose canvas is native AppKit with `WKWebView` portals, and `IgorHeck/open-maestri`, whose HTML canvas uses Electron `WebContentsView` overlays.

- In the desktop app, each URL-mode web widget owns a **native WebKit child webview** (`src-tauri/src/portal.rs`) layered over the canvas. Tauri's `unstable` feature enables child webviews; it adds no crates and leaves `Cargo.lock` unchanged.
- The widget body is a transparent **hole** (`NativePortal.tsx`). Every animation frame it measures its screen rectangle. When the rectangle changes, and every 120 ms otherwise, it sends bounds plus the *measured* scale.
- The page zoom equals the canvas scale, so zooming the canvas shrinks the page instead of reflowing it into a narrow layout.
- A native view always draws above the HTML canvas. It is shown only when the whole hole is inside the window and 17 sample points hit the hole itself. Any menu, dialog, dock panel, higher widget, or top bar covering it hides the native view, and a placeholder takes its place.
- Hidden portals keep their page state (login, scroll, forms). A portal is destroyed only when its widget unmounts: deletion or tab close.
- The URL bar updates from page loads and title changes. Committed URLs persist to the widget, and redirects do not cause reload loops. Back, forward, and reload act on the native view.
- `window.open` popups, needed by OAuth sign-in, open as real windows that share the portal's WebKit configuration and cookies.
- Web mode and local-HTML mode keep the iframe implementation.

## Security boundary

Portal content is arbitrary remote web content.

- **IPC:** Tauri 2.11 rejects custom-command and plugin IPC from remote origins unless a capability lists them (`remote_origin_blocked_for_custom_commands_without_app_manifest`). ccanvas defines no remote capability.
- **Navigation:** portals and popups navigate only to `http(s)` and `about:blank`. They never load `file:`, `javascript:`, `data:`, custom schemes (`tauri:`, `asset:`, `ipc:`), or ccanvas's own frontend origin, which Tauri treats as local and trusted.
- **Asset protocol:** responses reflect only the app origin in CORS, so remote pages cannot read `asset://` responses. They may still embed `asset://` images/media by URL, a residual shared with the scope `**` noted in Phase 6.
- **Storage:** logins persist in the app's default WebKit data store, shared by all portals, like one browser profile. There is no in-app "clear website data" control yet.

## Known limits

- A portal partly scrolled off the canvas, or partly covered, hides entirely rather than clipping.
- While a portal has focus, canvas keyboard shortcuts and wheel-zoom go to the page; click the canvas to return.
- A native view cannot sit beneath other widgets or tooltips. Covering it hides it.
- No per-portal isolated profiles or data-clearing UI. Pi agents can drive arrow-connected portals; see [agent browser control](agent-browser-control.md).
