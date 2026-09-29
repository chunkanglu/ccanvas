// In-process pseudo-terminals for ccanvas terminal/agent widgets.
//
// Each session is a real shell behind a platform PTY (ConPTY on Windows,
// openpty elsewhere). Output streams to the webview as `pty:data` events
// carrying raw bytes; `pty:exit` fires when the shell ends.
//
// Sessions are keyed by the *widget id*, which is stable across a webview
// reload (the workspace is restored from the autosaved session). That's what
// lets a terminal survive ccanvas's own dev hot-reload: when the webview
// reloads, the new frontend calls `pty_open` with the same id and re-attaches
// to the still-running shell — replaying its scrollback — instead of spawning a
// fresh one. So a build or a `claude` agent running inside ccanvas keeps going
// while you edit ccanvas's source. The shell is only torn down by `pty_kill`,
// which the store calls when the widget is actually deleted.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Recent output retained per session and replayed when a webview (re)attaches.
/// Caps the memory a long-lived, chatty shell can hold; older output is dropped.
const SCROLLBACK_CAP: usize = 1024 * 1024; // 1 MiB

/// Output pump for one session. The reader thread starts at spawn time (so
/// ConPTY output is captured from t=0 — Windows does not buffer for a late
/// reader) and always appends to `scrollback`. It only emits `pty:data` while
/// `live` is set; `pty_open` clears `live` and `pty_start` sets it after
/// replaying the buffer, so a (re)attaching webview gets every byte exactly
/// once with no gap and no duplication.
struct Pump {
    live: bool,
    scrollback: Vec<u8>,
    /// Output arrived since the last snapshot save.
    dirty: bool,
}

pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    pump: Arc<Mutex<Pump>>,
    /// Plain terminals opt in to restart snapshots (see `snapshot`). Agent
    /// terminals resume through their harness instead.
    persist: bool,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
}

#[derive(Clone, Serialize)]
struct PtyData {
    id: String,
    bytes: Vec<u8>,
}

#[derive(Clone, Serialize)]
struct PtyExit {
    id: String,
}

fn default_shell() -> CommandBuilder {
    let mut cmd = if cfg!(windows) {
        let shell = std::env::var("CCANVAS_SHELL").unwrap_or_else(|_| "powershell.exe".into());
        CommandBuilder::new(shell)
    } else {
        let shell = std::env::var("CCANVAS_SHELL")
            .or_else(|_| std::env::var("SHELL"))
            .unwrap_or_else(|_| "bash".into());
        CommandBuilder::new(shell)
    };
    // Keep PATH/SystemRoot/etc., but advertise the renderer we actually host.
    // Finder/Spotlight launches commonly have no TERM; inheriting that makes
    // zsh use dumb-terminal editing (e.g. backspaces paint blanks). A parent
    // terminal's own TERM may also describe capabilities xterm.js lacks.
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    configure_terminal_env(&mut cmd);
    cmd
}

fn configure_terminal_env(cmd: &mut CommandBuilder) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn terminal_capabilities_do_not_depend_on_launcher_environment() {
        for inherited in [None, Some("dumb"), Some("xterm-ghostty")] {
            let mut cmd = CommandBuilder::new("unused-test-shell");
            cmd.env_clear();
            cmd.env("KEEP_ME", "unchanged");
            if let Some(value) = inherited {
                cmd.env("TERM", value);
            }
            cmd.env("COLORTERM", "incorrect-parent-value");
            configure_terminal_env(&mut cmd);
            assert_eq!(cmd.get_env("TERM"), Some(OsStr::new("xterm-256color")));
            assert_eq!(cmd.get_env("COLORTERM"), Some(OsStr::new("truecolor")));
            assert_eq!(cmd.get_env("KEEP_ME"), Some(OsStr::new("unchanged")));
        }
    }

    #[test]
    fn restored_history_drops_terminal_queries_but_keeps_output() {
        let saved = b"\x1b[31mred\x1b[0m\x1b[c\x1b[6n\x1b[>c\x1b[14t\x1b[?2004$p\x1b[>q\x1b]11;?\x07\x1bP$qm\x1b\\\x1b]0;title\x07ok\r\n";
        let clean = snapshot::strip_queries(saved);
        assert_eq!(clean, b"\x1b[31mred\x1b[0m\x1b]0;title\x07ok\r\n".to_vec());
        // a truncated trailing sequence is dropped, not replayed half-open
        assert_eq!(snapshot::strip_queries(b"done\x1b[3"), b"done".to_vec());
    }

    #[test]
    fn snapshot_file_names_are_unique_and_path_safe() {
        assert_eq!(snapshot::file_stem("ws:a/../b"), "77733a612f2e2e2f62");
        assert_ne!(snapshot::file_stem("a:b"), snapshot::file_stem("a_b"));
        assert!(snapshot::RESTORE_TRAILER.ends_with(b"\x1b[0m\r\n"));
    }
}

/// Drop the oldest output once scrollback exceeds the cap, advancing to the
/// next line boundary so a replay never starts mid-escape-sequence.
fn trim_scrollback(buf: &mut Vec<u8>) {
    let mut cut = buf.len() - SCROLLBACK_CAP;
    if let Some(nl) = buf[cut..].iter().position(|&b| b == b'\n') {
        cut += nl + 1;
    }
    buf.drain(..cut.min(buf.len()));
}

/// Open (or re-attach to) the terminal session for `id`.
///
/// Returns `true` when an existing live shell was re-attached — e.g. the
/// webview reloaded during dev, or the user switched tabs and came back. In
/// that case the running shell, and whatever build or agent it holds, is left
/// untouched; the caller replays scrollback via `pty_start` and must NOT
/// relaunch anything. Returns `false` when a fresh shell was spawned.
#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    state: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    restore: Option<bool>,
) -> Result<bool, String> {
    let restore = restore.unwrap_or(false);
    {
        let mut sessions = state.sessions.lock().unwrap();
        if let Some(s) = sessions.get_mut(&id) {
            // re-attach only if the shell is still alive; a dead one is dropped
            // so we spawn fresh below (e.g. the user hit "retry" after it exited)
            if matches!(s.child.try_wait(), Ok(None)) {
                let _ = s.master.resize(PtySize {
                    rows: rows.max(1),
                    cols: cols.max(1),
                    pixel_width: 0,
                    pixel_height: 0,
                });
                // pause emitting until pty_start replays the buffer, so output
                // arriving between now and then is replayed once, not twice
                s.pump.lock().unwrap().live = false;
                return Ok(true);
            }
            sessions.remove(&id);
        }
    }
    spawn_session(app, state, id, cols, rows, cwd, restore)?;
    Ok(false)
}

fn spawn_session(
    app: AppHandle,
    state: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    restore: bool,
) -> Result<(), String> {
    // A restored terminal starts in its last live directory (if it still
    // exists) and begins with the saved history, so the next save carries it.
    let restored = if restore {
        snapshot::load(&app, &id)
    } else {
        None
    };
    let cwd = restored.as_ref().and_then(|r| r.cwd.clone()).or(cwd);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = default_shell();
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        cmd.cwd(dir);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // slave is no longer needed once the child owns it
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let pump = Arc::new(Mutex::new(Pump {
        live: false,
        scrollback: restored.map(|r| r.history).unwrap_or_default(),
        dirty: false,
    }));

    // insert before starting the reader so the exit cleanup below can never race
    // ahead of the insert and leave a dead session in the map
    state.sessions.lock().unwrap().insert(
        id.clone(),
        Session {
            master: pair.master,
            writer,
            child,
            pump: pump.clone(),
            persist: restore,
        },
    );

    // start reading immediately so ConPTY's initial output isn't lost; it's held
    // in `scrollback` until pty_start flips `live`
    let app_t = app.clone();
    let id_t = id.clone();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    let emit = {
                        let mut p = pump.lock().unwrap();
                        p.scrollback.extend_from_slice(&chunk[..n]);
                        p.dirty = true;
                        if p.scrollback.len() > SCROLLBACK_CAP {
                            trim_scrollback(&mut p.scrollback);
                        }
                        p.live
                    };
                    if emit {
                        let _ = app_t.emit(
                            "pty:data",
                            PtyData {
                                id: id_t.clone(),
                                bytes: chunk[..n].to_vec(),
                            },
                        );
                    }
                }
                Err(_) => break,
            }
        }
        // shell exited — tell the frontend (it falls back to its local shell) and
        // drop the session so a retry/relaunch spawns fresh, not a dead reattach
        let _ = app_t.emit("pty:exit", PtyExit { id: id_t.clone() });
        if let Some(mgr) = app_t.try_state::<PtyManager>() {
            mgr.sessions.lock().unwrap().remove(&id_t);
        }
    });

    Ok(())
}

/// Replay the session's scrollback to the webview and switch the pump to live
/// streaming. Called once the frontend has attached its pty:data / pty:exit
/// listeners — for both a fresh spawn (replays the shell's startup banner) and a
/// re-attach (replays the full retained history).
#[tauri::command]
pub fn pty_start(app: AppHandle, state: State<'_, PtyManager>, id: String) {
    let pump = state
        .sessions
        .lock()
        .unwrap()
        .get(&id)
        .map(|s| s.pump.clone());
    let Some(pump) = pump else { return };

    let replay = {
        let mut p = pump.lock().unwrap();
        p.live = true;
        p.scrollback.clone()
    };
    if !replay.is_empty() {
        let _ = app.emit("pty:data", PtyData { id, bytes: replay });
    }
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(s) = sessions.get_mut(&id) {
        s.writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        s.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(s) = sessions.get(&id) {
        s.master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Stop streaming to the webview but keep the shell running. Called when a
/// terminal widget unmounts for a reason that isn't deletion (a webview reload
/// or React remount) so the session survives to be re-attached by `pty_open`.
#[tauri::command]
pub fn pty_detach(state: State<'_, PtyManager>, id: String) {
    if let Some(s) = state.sessions.lock().unwrap().get(&id) {
        s.pump.lock().unwrap().live = false;
    }
}

/// Tear the shell down for good. Called when the widget is actually deleted,
/// so its restart snapshot goes too.
#[tauri::command]
pub fn pty_kill(app: AppHandle, state: State<'_, PtyManager>, id: String) {
    if let Some(mut s) = state.sessions.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
    snapshot::remove(&app, &id);
}

/// Save a restart snapshot for every persistent session. `only_dirty` skips
/// sessions with no output since their last save (the periodic crash guard);
/// app exit saves everything.
pub fn save_snapshots(app: &AppHandle, only_dirty: bool) {
    let Some(mgr) = app.try_state::<PtyManager>() else {
        return;
    };
    let pending: Vec<(String, Option<u32>, Vec<u8>)> = {
        let sessions = mgr.sessions.lock().unwrap();
        sessions
            .iter()
            .filter(|(_, s)| s.persist)
            .filter_map(|(id, s)| {
                let mut p = s.pump.lock().unwrap();
                if only_dirty && !p.dirty {
                    return None;
                }
                p.dirty = false;
                Some((id.clone(), s.child.process_id(), p.scrollback.clone()))
            })
            .collect()
    };
    // cwd lookup and disk IO happen outside the session lock
    for (id, pid, history) in pending {
        let cwd = pid.and_then(snapshot::process_cwd);
        snapshot::save(app, &id, &history, cwd.as_deref());
    }
}

/// Restart snapshots for plain terminals: raw output plus the shell's working
/// directory, stored privately under the app data dir — never in the portable
/// `.ccnvs` document, since terminal output can contain secrets.
pub mod snapshot {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, SystemTime};

    use tauri::{AppHandle, Manager};

    /// Snapshots unused this long are pruned at startup.
    const MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

    pub struct Restored {
        pub history: Vec<u8>,
        pub cwd: Option<String>,
    }

    fn dir(app: &AppHandle) -> Option<PathBuf> {
        app.path()
            .app_data_dir()
            .ok()
            .map(|d| d.join("terminal-snapshots"))
    }

    /// Hex of the runtime id: unique, filesystem-safe, no traversal.
    pub(crate) fn file_stem(id: &str) -> String {
        id.bytes().map(|b| format!("{b:02x}")).collect()
    }

    fn paths(app: &AppHandle, id: &str) -> Option<(PathBuf, PathBuf)> {
        let d = dir(app)?;
        let stem = file_stem(id);
        Some((d.join(format!("{stem}.out")), d.join(format!("{stem}.cwd"))))
    }

    fn ensure_private_dir(d: &Path) -> std::io::Result<()> {
        fs::create_dir_all(d)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(d, fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        let tmp = path.with_extension("tmp");
        {
            let mut options = fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            use std::io::Write;
            let mut file = options.open(&tmp)?;
            file.write_all(bytes)?;
        }
        fs::rename(tmp, path)
    }

    pub fn save(app: &AppHandle, id: &str, history: &[u8], cwd: Option<&str>) {
        let (Some(d), Some((out, cwd_path))) = (dir(app), paths(app, id)) else {
            return;
        };
        if ensure_private_dir(&d).is_err() {
            return;
        }
        let _ = write_private(&out, history);
        match cwd {
            Some(c) => {
                let _ = write_private(&cwd_path, c.as_bytes());
            }
            None => {
                let _ = fs::remove_file(&cwd_path);
            }
        }
    }

    pub fn load(app: &AppHandle, id: &str) -> Option<Restored> {
        let (out, cwd_path) = paths(app, id)?;
        let saved = fs::read(&out).ok()?;
        let cwd = fs::read_to_string(&cwd_path)
            .ok()
            .map(|c| c.trim_end_matches('\n').to_string())
            .filter(|c| Path::new(c).is_dir());
        let mut history = strip_queries(&saved);
        if history.is_empty() {
            return None;
        }
        history.extend_from_slice(RESTORE_TRAILER);
        Some(Restored { history, cwd })
    }

    pub fn remove(app: &AppHandle, id: &str) {
        if let Some((out, cwd)) = paths(app, id) {
            let _ = fs::remove_file(out);
            let _ = fs::remove_file(cwd);
        }
    }

    /// Delete snapshots nobody has resumed or saved for `MAX_AGE`.
    pub fn prune(app: &AppHandle) {
        let Some(d) = dir(app) else { return };
        let Ok(entries) = fs::read_dir(d) else { return };
        let now = SystemTime::now();
        for entry in entries.flatten() {
            let stale = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| now.duration_since(t).ok())
                .is_some_and(|age| age > MAX_AGE);
            if stale {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    /// Leave whatever full-screen state the old session ended in, then mark
    /// where live output resumes. Soft reset (DECSTR) plus explicit mouse /
    /// alt-screen / bracketed-paste exits, then a dim separator.
    pub(crate) const RESTORE_TRAILER: &[u8] = b"\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[!p\x1b[0m\r\n\x1b[2m\xe2\x94\x80\xe2\x94\x80 restored from previous session \xe2\x94\x80\xe2\x94\x80\x1b[0m\r\n";

    /// Remove sequences that make the terminal *answer*. Replaying them into a
    /// fresh xterm would type stale replies (e.g. `^[[?1;2c`) into the new
    /// shell. Drops: CSI with final `c`/`n`/`t` (DA, DSR/CPR, window reports),
    /// DECRQM (`$p`), XTVERSION (`>q`), OSC color queries (`;?`), and all DCS
    /// strings (DECRQSS, XTGETTCAP). Everything else is kept verbatim.
    pub(crate) fn strip_queries(input: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(input.len());
        let mut i = 0;
        while i < input.len() {
            if input[i] != 0x1b || i + 1 >= input.len() {
                out.push(input[i]);
                i += 1;
                continue;
            }
            match input[i + 1] {
                b'[' => {
                    // CSI: parameters/intermediates 0x20-0x3f, final 0x40-0x7e
                    let mut j = i + 2;
                    while j < input.len() && (0x20..=0x3f).contains(&input[j]) {
                        j += 1;
                    }
                    if j >= input.len() {
                        break; // truncated at the end: drop the fragment
                    }
                    let body = &input[i + 2..j];
                    let final_byte = input[j];
                    let query = matches!(final_byte, b'c' | b'n' | b't')
                        || (final_byte == b'p' && body.contains(&b'$'))
                        || (final_byte == b'q' && body.first() == Some(&b'>'));
                    if !query {
                        out.extend_from_slice(&input[i..=j]);
                    }
                    i = j + 1;
                }
                b']' | b'P' => {
                    // OSC / DCS: terminated by BEL or ST (ESC \)
                    let mut j = i + 2;
                    let mut end = None;
                    while j < input.len() {
                        if input[j] == 0x07 {
                            end = Some(j + 1);
                            break;
                        }
                        if input[j] == 0x1b && input.get(j + 1) == Some(&b'\\') {
                            end = Some(j + 2);
                            break;
                        }
                        j += 1;
                    }
                    let Some(end) = end else { break };
                    let is_dcs = input[i + 1] == b'P';
                    let body = &input[i + 2..end];
                    let color_query = body.windows(2).any(|w| w == b";?");
                    if !is_dcs && !color_query {
                        out.extend_from_slice(&input[i..end]);
                    }
                    i = end;
                }
                _ => {
                    out.push(input[i]);
                    i += 1;
                }
            }
        }
        out
    }

    /// The shell's current directory, read natively (no shell cooperation).
    pub fn process_cwd(pid: u32) -> Option<String> {
        #[cfg(target_os = "linux")]
        {
            return fs::read_link(format!("/proc/{pid}/cwd"))
                .ok()
                .map(|p| p.to_string_lossy().into_owned());
        }
        #[cfg(target_os = "macos")]
        {
            let output = std::process::Command::new("/usr/sbin/lsof")
                .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
                .output()
                .ok()?;
            return String::from_utf8_lossy(&output.stdout)
                .lines()
                .find_map(|line| line.strip_prefix('n').map(str::to_string));
        }
        #[allow(unreachable_code)]
        {
            let _ = pid;
            None
        }
    }
}
