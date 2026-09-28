//! Native web portals: real WebKit child webviews layered over the HTML canvas.
//!
//! An `<iframe>` cannot show sites that forbid framing and cannot host normal
//! logged-in browsing. A child webview is a separate native view, so the canvas
//! leaves a transparent "hole" and continuously sends its screen rectangle and
//! scale. This is the same approach Maestri (WKWebView over NSView) and
//! open-maestri (Electron WebContentsView) use.
//!
//! Security boundary: portal content is arbitrary remote web content. Tauri 2
//! rejects custom and plugin IPC from remote origins unless a capability names
//! them; ccanvas defines no remote capability. Portals only navigate to http(s)
//! and never to ccanvas's own frontend origin, which Tauri treats as local.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Runtime, State, Url,
    WebviewBuilder, WebviewUrl, WebviewWindowBuilder,
};

const MAIN_WINDOW: &str = "main";
const MIN_ZOOM: f64 = 0.25;
const MAX_ZOOM: f64 = 5.0;

struct PortalEntry {
    label: String,
    zoom: f64,
    visible: bool,
}

#[derive(Default)]
pub struct PortalManager {
    inner: Mutex<PortalInner>,
}

#[derive(Default)]
struct PortalInner {
    portals: HashMap<String, PortalEntry>,
    next: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortalState {
    id: String,
    url: Option<String>,
    title: Option<String>,
    loading: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortalBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
    zoom: f64,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 512 && !id.chars().any(char::is_control)
}

/// Origins Tauri considers "local" (the app's own frontend) would receive full
/// IPC. A portal must never load them.
fn app_origin(url: &Url, dev_url: Option<&Url>) -> bool {
    if matches!(url.scheme(), "tauri" | "asset" | "ipc") {
        return true;
    }
    if url.host_str() == Some("tauri.localhost") {
        return true;
    }
    dev_url.is_some_and(|dev| {
        dev.scheme() == url.scheme()
            && dev.port_or_known_default() == url.port_or_known_default()
            && matches!(
                (dev.host_str(), url.host_str()),
                (
                    Some("127.0.0.1" | "localhost"),
                    Some("127.0.0.1" | "localhost")
                )
            )
    })
}

/// Portal navigation is ordinary web browsing only: no file, custom-scheme,
/// javascript, or data URLs, and never ccanvas's own origin.
fn allowed_portal_url(url: &Url, dev_url: Option<&Url>) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && !app_origin(url, dev_url)
}

fn parse_portal_url(raw: &str, dev_url: Option<&Url>) -> Result<Url, String> {
    if raw.len() > 8192 || raw.chars().any(char::is_control) {
        return Err("Invalid portal URL".into());
    }
    let url = Url::parse(raw).map_err(|_| "Invalid portal URL".to_string())?;
    if !allowed_portal_url(&url, dev_url) {
        return Err("Portals can only open http(s) pages outside ccanvas".into());
    }
    Ok(url)
}

fn dev_url<R: Runtime>(app: &AppHandle<R>) -> Option<Url> {
    if cfg!(debug_assertions) {
        app.config().build.dev_url.clone()
    } else {
        None
    }
}

fn emit_state<R: Runtime>(app: &AppHandle<R>, state: PortalState) {
    let _ = app.emit_to(MAIN_WINDOW, "portal:state", state);
}

fn clamp_zoom(zoom: f64) -> f64 {
    if zoom.is_finite() {
        zoom.clamp(MIN_ZOOM, MAX_ZOOM)
    } else {
        1.0
    }
}

fn label_for(manager: &PortalManager, id: &str) -> Option<String> {
    manager
        .inner
        .lock()
        .ok()?
        .portals
        .get(id)
        .map(|entry| entry.label.clone())
}

fn webview_for<R: Runtime>(
    app: &AppHandle<R>,
    manager: &PortalManager,
    id: &str,
) -> Result<tauri::Webview<R>, String> {
    let label = label_for(manager, id).ok_or("Portal is not open")?;
    app.get_webview(&label)
        .ok_or_else(|| "Portal webview is gone".into())
}

/// Create (or reuse) the native portal for a canvas widget.
#[tauri::command]
pub async fn portal_open(
    app: AppHandle,
    state: State<'_, PortalManager>,
    id: String,
    url: String,
) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("Invalid portal id".into());
    }
    let dev = dev_url(&app);
    let target = parse_portal_url(&url, dev.as_ref())?;
    let label = {
        let mut inner = state.inner.lock().map_err(|_| "Portal state poisoned")?;
        if let Some(existing) = inner.portals.get(&id) {
            if app.get_webview(&existing.label).is_some() {
                return Ok(());
            }
        }
        inner.next += 1;
        let label = format!("portal-{}", inner.next);
        inner.portals.insert(
            id.clone(),
            PortalEntry {
                label: label.clone(),
                zoom: 1.0,
                visible: false,
            },
        );
        label
    };

    let window = app
        .get_window(MAIN_WINDOW)
        .ok_or("Main window is unavailable")?;
    let nav_dev = dev.clone();
    let load_app = app.clone();
    let load_id = id.clone();
    let title_app = app.clone();
    let title_id = id.clone();
    let popup_app = app.clone();
    let popup_dev = dev.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(target))
        .on_navigation(move |url| allowed_portal_url(url, nav_dev.as_ref()))
        .on_page_load(move |_webview, payload| {
            emit_state(
                &load_app,
                PortalState {
                    id: load_id.clone(),
                    url: Some(payload.url().to_string()),
                    title: None,
                    loading: Some(matches!(payload.event(), PageLoadEvent::Started)),
                },
            );
        })
        .on_document_title_changed(move |_webview, title| {
            emit_state(
                &title_app,
                PortalState {
                    id: title_id.clone(),
                    url: None,
                    title: Some(title.chars().take(512).collect()),
                    loading: None,
                },
            );
        })
        // OAuth and similar flows rely on window.open + opener messaging. Real
        // popup windows share the portal's WebKit configuration and cookies.
        .on_new_window(move |url, features| {
            if !allowed_portal_url(&url, popup_dev.as_ref()) {
                return NewWindowResponse::Deny;
            }
            static POPUPS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let n = POPUPS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            let nav_dev = popup_dev.clone();
            match WebviewWindowBuilder::new(
                &popup_app,
                format!("portal-popup-{n}"),
                WebviewUrl::External("about:blank".parse().expect("static URL")),
            )
            .window_features(features)
            .title(url.as_str())
            .on_navigation(move |url| allowed_portal_url(url, nav_dev.as_ref()))
            .build()
            {
                Ok(window) => NewWindowResponse::Create { window },
                Err(_) => NewWindowResponse::Deny,
            }
        });

    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|e| {
            if let Ok(mut inner) = state.inner.lock() {
                inner.portals.remove(&id);
            }
            e.to_string()
        })?;
    webview.hide().map_err(|e| e.to_string())
}

/// Position the native view over its DOM hole. Hidden portals keep their page
/// state (session, scroll, forms) instead of being destroyed.
#[tauri::command]
pub async fn portal_bounds(
    app: AppHandle,
    state: State<'_, PortalManager>,
    id: String,
    bounds: PortalBounds,
) -> Result<(), String> {
    let webview = webview_for(&app, &state, &id)?;
    let zoom = clamp_zoom(bounds.zoom);
    let visible = bounds.visible
        && [bounds.x, bounds.y, bounds.width, bounds.height]
            .iter()
            .all(|value| value.is_finite())
        && bounds.width >= 1.0
        && bounds.height >= 1.0;
    let (zoom_changed, visibility_changed) = {
        let mut inner = state.inner.lock().map_err(|_| "Portal state poisoned")?;
        let entry = inner.portals.get_mut(&id).ok_or("Portal is not open")?;
        let zoom_changed = (entry.zoom - zoom).abs() > f64::EPSILON;
        let visibility_changed = entry.visible != visible;
        entry.zoom = zoom;
        entry.visible = visible;
        (zoom_changed, visibility_changed)
    };
    if !visible {
        if visibility_changed {
            webview.hide().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    if zoom_changed {
        webview.set_zoom(zoom).map_err(|e| e.to_string())?;
    }
    webview
        .set_bounds(Rect {
            position: LogicalPosition::new(bounds.x.round(), bounds.y.round()).into(),
            size: LogicalSize::new(bounds.width.round(), bounds.height.round()).into(),
        })
        .map_err(|e| e.to_string())?;
    if visibility_changed {
        webview.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn portal_navigate(
    app: AppHandle,
    state: State<'_, PortalManager>,
    id: String,
    url: String,
) -> Result<(), String> {
    let target = parse_portal_url(&url, dev_url(&app).as_ref())?;
    webview_for(&app, &state, &id)?
        .navigate(target)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn portal_action(
    app: AppHandle,
    state: State<'_, PortalManager>,
    id: String,
    action: String,
) -> Result<(), String> {
    let webview = webview_for(&app, &state, &id)?;
    match action.as_str() {
        "back" => webview.eval("history.back()"),
        "forward" => webview.eval("history.forward()"),
        "reload" => webview.reload(),
        "focus" => webview.set_focus(),
        _ => return Err("Unknown portal action".into()),
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn portal_close(
    app: AppHandle,
    state: State<'_, PortalManager>,
    id: String,
) -> Result<(), String> {
    let entry = state
        .inner
        .lock()
        .map_err(|_| "Portal state poisoned")?
        .portals
        .remove(&id);
    if let Some(entry) = entry {
        if let Some(webview) = app.get_webview(&entry.label) {
            webview.close().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portals_only_browse_external_http_origins() {
        let dev: Url = "http://127.0.0.1:5174".parse().unwrap();
        let ok = |raw: &str| parse_portal_url(raw, Some(&dev)).is_ok();
        assert!(ok("https://github.com/login"));
        assert!(ok("http://localhost:3000"));
        assert!(ok("about:blank"));
        assert!(!ok("file:///etc/passwd"));
        assert!(!ok("javascript:alert(1)"));
        assert!(!ok("data:text/html,hi"));
        assert!(!ok("asset://localhost/Users/me/.ssh/id_rsa"));
        assert!(!ok("tauri://localhost"));
        assert!(!ok("http://tauri.localhost/"));
        assert!(!ok("http://127.0.0.1:5174/"));
        assert!(!ok("http://localhost:5174/#x"));
        assert!(!ok("https://example.com/\nbad"));
        assert!(ok("http://127.0.0.1:5175/"));
    }

    #[test]
    fn zoom_is_bounded() {
        assert_eq!(clamp_zoom(0.1), MIN_ZOOM);
        assert_eq!(clamp_zoom(9.0), MAX_ZOOM);
        assert_eq!(clamp_zoom(f64::NAN), 1.0);
        assert_eq!(clamp_zoom(0.8), 0.8);
    }
}
