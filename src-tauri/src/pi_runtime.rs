//! Managed native Pi TUI runtime plus private structured companion channel.
//!
//! The PTY remains the full-fidelity presentation/input path. Structured state
//! arrives independently over a per-process, capability-authenticated loopback
//! socket owned by this backend. Tokens are never emitted to the webview/logs.

use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{ErrorKind, Read, Write};
use std::net::{IpAddr, Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

const SCROLLBACK_CAP: usize = 1024 * 1024;
const MAX_FRAME_BYTES: usize = 256 * 1024;
const MAX_REPLAY_EVENTS: usize = 512;
const MAX_REPLAY_BYTES: usize = 4 * 1024 * 1024;
const PROTOCOL_VERSION: u64 = 1;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const COMPANION_WRITE_TIMEOUT: Duration = Duration::from_millis(500);

struct Pump {
    live: bool,
    scrollback: Vec<u8>,
}

struct StoredEvent {
    _frame: Value,
    bytes: usize,
}

#[derive(Default)]
struct CompanionState {
    authenticated: bool,
    live: bool,
    writer: Option<TcpStream>,
    events: VecDeque<StoredEvent>,
    event_bytes: usize,
    last_seq: Option<u64>,
    session_snapshot: Option<Value>,
    lifecycle_snapshot: Option<Value>,
    recovering: bool,
}

#[derive(Clone, PartialEq)]
struct LaunchIdentity {
    requested_cwd: String,
}

struct RuntimeSession {
    generation: u64,
    widget_id: String,
    attachment_id: String,
    open_epoch: u64,
    launch: LaunchIdentity,
    root_pid: u32,
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    pump: Arc<Mutex<Pump>>,
    companion: Arc<Mutex<CompanionState>>,
    closed: Arc<AtomicBool>,
}

#[derive(Default)]
struct RuntimeInner {
    sessions: HashMap<String, RuntimeSession>,
    generations: HashMap<String, u64>,
}

#[derive(Default)]
pub struct PiRuntimeManager {
    inner: Mutex<RuntimeInner>,
}

impl Drop for PiRuntimeManager {
    fn drop(&mut self) {
        if let Ok(inner) = self.inner.get_mut() {
            for (_, mut session) in inner.sessions.drain() {
                session.closed.store(true, Ordering::Release);
                close_companion(&session.companion);
                kill_tree(&mut session);
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiOpenRequest {
    /** Process-manager identity (workspace instance + widget). */
    id: String,
    /** Portable canvas widget identity carried by companion frames. */
    widget_id: String,
    /** Ephemeral webview attachment lease, distinct from process generation. */
    attachment_id: String,
    /** Monotonic client intent time, used to order delete/open races. */
    open_epoch: u64,
    cols: u16,
    rows: u16,
    cwd: String,
    session_file: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    thinking_level: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiOpenResult {
    reattached: bool,
    generation: u64,
    companion_connected: bool,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PiControl {
    Prompt {
        text: String,
        #[serde(rename = "deliverAs")]
        deliver_as: Option<String>,
    },
    Abort,
    Rename {
        name: String,
    },
    Shutdown,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PiPtyData {
    id: String,
    generation: u64,
    bytes: Vec<u8>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PiExit {
    id: String,
    generation: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanionStatus {
    id: String,
    generation: u64,
    connected: bool,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanionData {
    id: String,
    generation: u64,
    replayed: bool,
    frame: Value,
}

struct CompanionEndpoint {
    app: AppHandle,
    runtime_id: String,
    widget_id: String,
    generation: u64,
    token: String,
    child_pid: u32,
    companion: Arc<Mutex<CompanionState>>,
    closed: Arc<AtomicBool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForkConfig {
    pi_launcher: PiLauncher,
}

#[derive(Deserialize)]
struct PiLauncher {
    program: String,
    env: HashMap<String, String>,
}

fn fork_config() -> Result<ForkConfig, String> {
    serde_json::from_str(include_str!("../../fork.config.json")).map_err(|e| e.to_string())
}

fn trim_scrollback(buf: &mut Vec<u8>) {
    let mut cut = buf.len() - SCROLLBACK_CAP;
    if let Some(nl) = buf[cut..].iter().position(|&byte| byte == b'\n') {
        cut += nl + 1;
    }
    buf.drain(..cut.min(buf.len()));
}

fn valid_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && !value
            .chars()
            .any(|ch| (ch as u32) < 0x20 && ch != '\n' && ch != '\t')
        && !value.contains('\u{7f}')
}

fn valid_identifier(value: &str, max: usize) -> bool {
    valid_text(value, max) && !value.chars().any(|ch| matches!(ch, '\n' | '\t'))
}

fn working_directory(value: &str) -> Result<String, String> {
    let path = if value == "~" {
        PathBuf::from(std::env::var_os("HOME").ok_or("Home directory is unavailable")?)
    } else {
        PathBuf::from(value)
    };
    if !path.is_absolute() || !path.is_dir() {
        return Err("Managed Pi working directory must be an existing absolute directory".into());
    }
    Ok(path.to_string_lossy().into_owned())
}

fn exact_session_file(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else { return Ok(None) };
    if !valid_text(&value, 8192) {
        return Err("Invalid Pi session file".into());
    }
    let path = Path::new(&value);
    if !path.is_absolute() || !path.is_file() {
        return Err("Pi resume requires an existing absolute session file".into());
    }
    Ok(Some(value))
}

#[cfg(unix)]
fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(windows)]
fn executable(path: &Path) -> bool {
    path.is_file()
}

fn resolve_program(program: &str) -> Result<PathBuf, String> {
    if !valid_identifier(program, 1024) {
        return Err("Invalid Pi launcher program".into());
    }
    let requested = Path::new(program);
    if requested.components().count() > 1 {
        if executable(requested) {
            return Ok(requested.to_path_buf());
        }
        return Err(format!(
            "Configured Pi executable is unavailable: {program}"
        ));
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join(program);
            if executable(&candidate) {
                return Ok(candidate);
            }
        }
    }
    let mut candidates = Vec::new();
    if let Some(user) = std::env::var_os("USER") {
        candidates.push(
            PathBuf::from("/etc/profiles/per-user")
                .join(user)
                .join("bin")
                .join(program),
        );
    }
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join(".nix-profile/bin").join(program));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin").join(program));
    candidates.push(PathBuf::from("/usr/local/bin").join(program));
    candidates
        .into_iter()
        .find(|candidate| executable(candidate))
        .ok_or_else(|| {
            format!("Pi executable '{program}' was not found; no installation was attempted")
        })
}

fn companion_extension(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let source =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/pi-companion-extension.ts");
        if source.is_file() {
            return Ok(source);
        }
    }
    let resource = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("companion/scripts/pi-companion-extension.ts");
    if resource.is_file() {
        Ok(resource)
    } else {
        Err("Packaged Pi companion extension is missing".into())
    }
}

#[cfg(unix)]
fn capability_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(|e| format!("Unable to generate Pi companion capability: {e}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

#[cfg(windows)]
fn capability_token() -> Result<String, String> {
    Err("Managed Pi capability generation is not implemented on Windows yet".into())
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.as_bytes()
        .iter()
        .zip(right.as_bytes())
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

fn inherited_env(command: &mut CommandBuilder) {
    // CommandBuilder starts with a parent-environment snapshot. Clear it before
    // adding the filtered copy so stale Pi/cmux identity cannot survive.
    command.env_clear();
    for (key, value) in std::env::vars_os() {
        let key_text = key.to_string_lossy();
        if key_text.starts_with("CMUX_")
            || key_text.starts_with("CCANVAS_COMPANION_")
            || matches!(
                key_text.as_ref(),
                "PI_SESSION_ID"
                    | "PI_SESSION_FILE"
                    | "PI_PROVIDER"
                    | "PI_MODEL"
                    | "PI_REASONING_LEVEL"
            )
        {
            continue;
        }
        command.env(key, value);
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
}

fn validate_model_part(value: &Option<String>, label: &str) -> Result<(), String> {
    if value
        .as_deref()
        .is_some_and(|value| !valid_identifier(value, 1024))
    {
        return Err(format!("Invalid Pi {label}"));
    }
    Ok(())
}

fn validate_thinking_level(value: &Option<String>) -> Result<(), String> {
    if value.as_deref().is_some_and(|level| {
        !matches!(
            level,
            "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
        )
    }) {
        return Err("Invalid Pi thinking level".into());
    }
    Ok(())
}

fn append_model_args(command: &mut CommandBuilder, provider: Option<&str>, model: Option<&str>) {
    if let Some(model) = model {
        command.arg("--model");
        if let Some(provider) = provider {
            if model.contains('/') {
                command.arg(model);
            } else {
                command.arg(format!("{provider}/{model}"));
            }
        } else {
            command.arg(model);
        }
    } else if let Some(provider) = provider {
        command.arg("--provider");
        command.arg(provider);
    }
}

fn build_command(
    app: &AppHandle,
    request: &PiOpenRequest,
    listener_port: u16,
    token: &str,
    generation: u64,
    session_file: Option<&str>,
) -> Result<CommandBuilder, String> {
    let config = fork_config()?;
    let program = resolve_program(&config.pi_launcher.program)?;
    let extension = companion_extension(app)?;
    validate_model_part(&request.provider, "provider")?;
    validate_model_part(&request.model, "model")?;
    validate_thinking_level(&request.thinking_level)?;

    let mut command = CommandBuilder::new(program);
    inherited_env(&mut command);
    for (key, value) in config.pi_launcher.env {
        command.env(key, value);
    }
    command.env("CCANVAS_COMPANION_HOST", "127.0.0.1");
    command.env("CCANVAS_COMPANION_PORT", listener_port.to_string());
    command.env("CCANVAS_COMPANION_TOKEN", token);
    command.env("CCANVAS_COMPANION_WIDGET_ID", &request.widget_id);
    command.env("CCANVAS_COMPANION_GENERATION", generation.to_string());
    command.arg("-e");
    command.arg(extension);
    if let Some(path) = session_file {
        command.arg("--session");
        command.arg(path);
    }
    append_model_args(
        &mut command,
        request.provider.as_deref(),
        request.model.as_deref(),
    );
    if let Some(level) = &request.thinking_level {
        command.arg("--thinking");
        command.arg(level);
    }
    command.cwd(&request.cwd);
    Ok(command)
}

fn close_companion(companion: &Arc<Mutex<CompanionState>>) {
    if let Ok(mut state) = companion.lock() {
        state.authenticated = false;
        if let Some(stream) = state.writer.take() {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }
}

#[cfg(unix)]
extern "C" {
    fn getsid(pid: i32) -> i32;
}

#[cfg(unix)]
fn session_member_pids(session_id: u32) -> Vec<u32> {
    let Ok(output) = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid="])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .filter_map(|pid| pid.parse::<u32>().ok())
        .filter(|pid| {
            i32::try_from(*pid)
                .ok()
                .is_some_and(|pid| unsafe { getsid(pid) } == session_id as i32)
        })
        .collect()
}

#[cfg(unix)]
fn signal_process(signal: &str, target: String) {
    let _ = std::process::Command::new("/bin/kill")
        .arg(signal)
        .arg(target)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

#[cfg(unix)]
fn terminate_process_tree(root: u32, child: &mut dyn portable_pty::Child) {
    // portable-pty starts the child with setsid(), so its launch PID is the
    // stable session/process-group leader. Keep the direct child unreaped until
    // escalation so the numeric session ID cannot be reused during the grace
    // period; enumerate current session members immediately before each signal.
    signal_process("-HUP", format!("-{root}"));
    for pid in session_member_pids(root) {
        signal_process("-HUP", pid.to_string());
    }

    let deadline = Instant::now() + Duration::from_millis(500);
    while Instant::now() < deadline {
        if session_member_pids(root).is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    for pid in session_member_pids(root) {
        signal_process("-KILL", pid.to_string());
    }
    signal_process("-KILL", format!("-{root}"));
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
fn kill_tree(session: &mut RuntimeSession) {
    terminate_process_tree(session.root_pid, session.child.as_mut());
}

#[cfg(windows)]
fn kill_tree(session: &mut RuntimeSession) {
    let _ = session.child.kill();
    let _ = session.child.wait();
}

fn status(app: &AppHandle, id: &str, generation: u64, connected: bool, error: Option<String>) {
    let _ = app.emit(
        "pi:companion-status",
        CompanionStatus {
            id: id.to_string(),
            generation,
            connected,
            error,
        },
    );
}

fn read_frames(
    stream: &mut TcpStream,
    buffer: &mut Vec<u8>,
) -> Result<Option<Vec<Vec<u8>>>, String> {
    let mut chunk = [0u8; 8192];
    match stream.read(&mut chunk) {
        Ok(0) if buffer.is_empty() => return Ok(None),
        Ok(0) => return Err("Truncated companion frame".into()),
        Ok(count) => buffer.extend_from_slice(&chunk[..count]),
        Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
            return Ok(Some(Vec::new()))
        }
        Err(error) => return Err(error.to_string()),
    }
    if buffer.len() > MAX_FRAME_BYTES && !buffer.contains(&b'\n') {
        return Err("Unterminated companion frame exceeded bound".into());
    }
    let mut frames = Vec::new();
    while let Some(index) = buffer.iter().position(|byte| *byte == b'\n') {
        let mut frame: Vec<u8> = buffer.drain(..=index).collect();
        frame.pop();
        if frame.last() == Some(&b'\r') {
            frame.pop();
        }
        if frame.is_empty() || frame.len() > MAX_FRAME_BYTES {
            return Err("Invalid companion frame bound".into());
        }
        frames.push(frame);
    }
    if buffer.len() > MAX_FRAME_BYTES {
        return Err("Companion frame exceeded bound".into());
    }
    Ok(Some(frames))
}

fn runtime_matches(frame: &Value, id: &str, generation: u64) -> bool {
    frame.get("v").and_then(Value::as_u64) == Some(PROTOCOL_VERSION)
        && frame.get("widgetId").and_then(Value::as_str) == Some(id)
        && frame.get("generation").and_then(Value::as_u64) == Some(generation)
}

fn optional_text(value: &Value, key: &str, max: usize) -> bool {
    value.get(key).map_or(true, |candidate| {
        candidate
            .as_str()
            .is_some_and(|candidate| valid_text(candidate, max))
    })
}

fn optional_bool(value: &Value, key: &str) -> bool {
    value.get(key).map_or(true, Value::is_boolean)
}

fn safe_integer(value: &Value, key: &str, min: u64) -> Option<u64> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .filter(|candidate| *candidate >= min && *candidate <= MAX_SAFE_INTEGER)
}

fn validate_event_payload(event: &Value) -> Result<(), String> {
    let kind = event
        .get("type")
        .and_then(Value::as_str)
        .ok_or("Invalid companion event")?;
    match kind {
        "session" => {
            if !matches!(
                event.get("phase").and_then(Value::as_str),
                Some("start" | "info" | "shutdown")
            ) || !["reason", "sessionId", "name", "thinkingLevel"]
                .iter()
                .all(|key| optional_text(event, key, 1024))
                || !optional_text(event, "sessionFile", 8192)
            {
                return Err("Invalid companion session event".into());
            }
            if let Some(model) = event.get("model") {
                if !model.is_object()
                    || !model
                        .get("provider")
                        .and_then(Value::as_str)
                        .is_some_and(|value| valid_text(value, 256))
                    || !model
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|value| valid_text(value, 1024))
                {
                    return Err("Invalid companion session model".into());
                }
            }
        }
        "lifecycle" => {
            if !matches!(
                event.get("phase").and_then(Value::as_str),
                Some("agent_start" | "agent_end" | "agent_settled" | "turn_start" | "turn_end")
            ) || event
                .get("turnIndex")
                .is_some_and(|_| safe_integer(event, "turnIndex", 0).is_none())
                || event.get("outcome").is_some_and(|outcome| {
                    !matches!(
                        outcome.as_str(),
                        Some("completed" | "aborted" | "failed" | "unknown")
                    )
                })
            {
                return Err("Invalid companion lifecycle event".into());
            }
        }
        "assistant" => {
            if !matches!(
                event.get("phase").and_then(Value::as_str),
                Some("start" | "delta" | "end")
            ) || event.get("text").is_some_and(|text| !text.is_string())
                || !optional_bool(event, "truncated")
            {
                return Err("Invalid companion assistant event".into());
            }
        }
        "tool" => {
            if !matches!(
                event.get("phase").and_then(Value::as_str),
                Some("start" | "update" | "end")
            ) || !event
                .get("callId")
                .and_then(Value::as_str)
                .is_some_and(|value| valid_text(value, 512))
                || !event
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|value| valid_text(value, 512))
                || !optional_bool(event, "isError")
                || !optional_bool(event, "truncated")
            {
                return Err("Invalid companion tool event".into());
            }
        }
        "runtime_error" => {
            if !event
                .get("code")
                .and_then(Value::as_str)
                .is_some_and(|value| valid_text(value, 256))
                || !event
                    .get("message")
                    .and_then(Value::as_str)
                    .is_some_and(|value| valid_text(value, 8192))
            {
                return Err("Invalid companion runtime error".into());
            }
        }
        _ => return Err("Unknown companion event".into()),
    }
    Ok(())
}

enum HostFrameKind {
    Event(u64),
    Result,
    Pong,
}

fn decode_host_frame(
    raw: &[u8],
    widget_id: &str,
    generation: u64,
) -> Result<(Value, HostFrameKind), String> {
    let frame: Value = serde_json::from_slice(raw).map_err(|_| "Invalid companion JSON")?;
    if !frame.is_object() || !runtime_matches(&frame, widget_id, generation) {
        return Err("Companion runtime identity mismatch".into());
    }
    if frame.get("token").is_some() {
        return Err("Capability token is only valid in the hello frame".into());
    }
    let kind = match frame.get("type").and_then(Value::as_str) {
        Some("event") => {
            let seq = safe_integer(&frame, "seq", 0).ok_or("Invalid companion sequence")?;
            validate_event_payload(frame.get("event").ok_or("Invalid companion event")?)?;
            HostFrameKind::Event(seq)
        }
        Some("result") => {
            if !frame
                .get("requestId")
                .and_then(Value::as_str)
                .is_some_and(|value| valid_text(value, 256))
                || !frame.get("ok").is_some_and(Value::is_boolean)
                || !optional_text(&frame, "error", 8192)
            {
                return Err("Invalid companion result".into());
            }
            HostFrameKind::Result
        }
        Some("pong") => {
            if !frame
                .get("nonce")
                .and_then(Value::as_str)
                .is_some_and(|value| valid_text(value, 256))
            {
                return Err("Invalid companion pong".into());
            }
            HostFrameKind::Pong
        }
        _ => return Err("Unexpected companion frame".into()),
    };
    Ok((frame, kind))
}

fn authenticate(
    frame: &[u8],
    id: &str,
    generation: u64,
    token: &str,
    child_pid: u32,
) -> Result<(), String> {
    let value: Value = serde_json::from_slice(frame).map_err(|_| "Invalid companion hello")?;
    if !runtime_matches(&value, id, generation)
        || value.get("type").and_then(Value::as_str) != Some("hello")
        || value.get("pid").and_then(Value::as_u64) != Some(child_pid as u64)
        || !value
            .get("token")
            .and_then(Value::as_str)
            .is_some_and(|candidate| constant_time_eq(candidate, token))
    {
        return Err("Companion authentication failed".into());
    }
    Ok(())
}

fn retain_event(state: &mut CompanionState, frame: Value, bytes: usize) {
    state.events.push_back(StoredEvent {
        _frame: frame,
        bytes,
    });
    state.event_bytes += bytes;
    while state.events.len() > MAX_REPLAY_EVENTS || state.event_bytes > MAX_REPLAY_BYTES {
        if let Some(removed) = state.events.pop_front() {
            state.event_bytes -= removed.bytes;
        }
    }
}

fn replay_delivery(state: &mut CompanionState, frame: &Value, sequence_gap: bool) -> bool {
    if sequence_gap {
        state.recovering = true;
    }
    let replayed = state.recovering;
    let reset_complete = frame.get("event").is_some_and(|event| {
        event.get("type").and_then(Value::as_str) == Some("runtime_error")
            && event.get("code").and_then(Value::as_str) == Some("replay_reset_complete")
    });
    if reset_complete {
        state.recovering = false;
    }
    replayed
}

fn process_frame(
    app: &AppHandle,
    runtime_id: &str,
    widget_id: &str,
    generation: u64,
    companion: &Arc<Mutex<CompanionState>>,
    raw: &[u8],
) -> Result<(), String> {
    let (frame, kind) = decode_host_frame(raw, widget_id, generation)?;
    match kind {
        HostFrameKind::Event(seq) => {
            let mut state = companion.lock().map_err(|_| "Companion state poisoned")?;
            if state.last_seq.is_some_and(|last| seq <= last) {
                return Ok(()); // replayed duplicate
            }
            let sequence_gap = if let Some(last) = state.last_seq {
                if seq != last + 1 {
                    status(
                        app,
                        runtime_id,
                        generation,
                        true,
                        Some(format!(
                            "Companion replay gap: expected {}, received {seq}",
                            last + 1
                        )),
                    );
                    true
                } else {
                    false
                }
            } else if seq != 0 {
                status(
                    app,
                    runtime_id,
                    generation,
                    true,
                    Some(format!("Companion replay starts at {seq}, expected 0")),
                );
                true
            } else {
                false
            };
            let replayed = replay_delivery(&mut state, &frame, sequence_gap);
            state.last_seq = Some(seq);
            retain_event(&mut state, frame.clone(), raw.len());
            if let Some(event) = frame.get("event") {
                match (
                    event.get("type").and_then(Value::as_str),
                    event.get("phase").and_then(Value::as_str),
                ) {
                    (Some("session"), _) => state.session_snapshot = Some(frame.clone()),
                    (Some("lifecycle"), Some("agent_start" | "agent_settled")) => {
                        state.lifecycle_snapshot = Some(frame.clone());
                    }
                    _ => {}
                }
            }
            let live = state.live;
            drop(state);
            if live {
                let _ = app.emit(
                    "pi:companion",
                    CompanionData {
                        id: runtime_id.to_string(),
                        generation,
                        replayed,
                        frame,
                    },
                );
            }
            Ok(())
        }
        HostFrameKind::Result | HostFrameKind::Pong => {
            let _ = app.emit(
                "pi:companion",
                CompanionData {
                    id: runtime_id.to_string(),
                    generation,
                    replayed: false,
                    frame,
                },
            );
            Ok(())
        }
    }
}

fn handle_connection(endpoint: &CompanionEndpoint, mut stream: TcpStream) -> Result<(), String> {
    let app = &endpoint.app;
    let runtime_id = endpoint.runtime_id.as_str();
    let widget_id = endpoint.widget_id.as_str();
    let generation = endpoint.generation;
    let token = endpoint.token.as_str();
    let child_pid = endpoint.child_pid;
    let companion = &endpoint.companion;
    let closed = &endpoint.closed;
    if !stream
        .peer_addr()
        .map_err(|e| e.to_string())?
        .ip()
        .is_loopback()
    {
        return Err("Rejected non-loopback companion peer".into());
    }
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(COMPANION_WRITE_TIMEOUT))
        .map_err(|e| e.to_string())?;
    stream.set_nodelay(true).map_err(|e| e.to_string())?;
    let mut buffer = Vec::new();
    let authentication_deadline = Instant::now() + Duration::from_secs(5);
    let hello = loop {
        if closed.load(Ordering::Acquire) {
            return Ok(());
        }
        if Instant::now() >= authentication_deadline {
            return Err("Companion authentication timed out".into());
        }
        let Some(frames) = read_frames(&mut stream, &mut buffer)? else {
            return Err("Companion disconnected before authentication".into());
        };
        if !frames.is_empty() {
            if frames.len() != 1 || !buffer.is_empty() {
                return Err("Unexpected traffic during companion authentication".into());
            }
            break frames.into_iter().next().unwrap();
        }
    };
    authenticate(&hello, widget_id, generation, token, child_pid)?;

    let replay_from = companion
        .lock()
        .map_err(|_| "Companion state poisoned")?
        .last_seq
        .map_or(0, |seq| seq + 1);
    let welcome = json!({
        "v": PROTOCOL_VERSION,
        "type": "welcome",
        "widgetId": widget_id,
        "generation": generation,
        "replayFrom": replay_from,
    });
    let mut encoded = serde_json::to_vec(&welcome).map_err(|e| e.to_string())?;
    encoded.push(b'\n');
    stream.write_all(&encoded).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;
    {
        let mut state = companion.lock().map_err(|_| "Companion state poisoned")?;
        state.writer = Some(stream.try_clone().map_err(|e| e.to_string())?);
        state.authenticated = true;
    }
    status(app, runtime_id, generation, true, None);

    loop {
        if closed.load(Ordering::Acquire) {
            return Ok(());
        }
        let Some(frames) = read_frames(&mut stream, &mut buffer)? else {
            return Ok(());
        };
        for frame in frames {
            process_frame(app, runtime_id, widget_id, generation, companion, &frame)?;
        }
    }
}

fn companion_listener(endpoint: CompanionEndpoint, listener: TcpListener) {
    let _ = listener.set_nonblocking(true);
    while !endpoint.closed.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => {
                let result = handle_connection(&endpoint, stream);
                close_companion(&endpoint.companion);
                if let Err(error) = result {
                    status(
                        &endpoint.app,
                        &endpoint.runtime_id,
                        endpoint.generation,
                        false,
                        Some(error),
                    );
                } else if !endpoint.closed.load(Ordering::Acquire) {
                    status(
                        &endpoint.app,
                        &endpoint.runtime_id,
                        endpoint.generation,
                        false,
                        Some("Companion disconnected".into()),
                    );
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => {
                status(
                    &endpoint.app,
                    &endpoint.runtime_id,
                    endpoint.generation,
                    false,
                    Some(error.to_string()),
                );
                break;
            }
        }
    }
}

fn prepare_reattach(session: &RuntimeSession) -> bool {
    let mut state = session.companion.lock().unwrap();
    state.live = false;
    state.authenticated
}

fn remove_session(manager: &PiRuntimeManager, id: &str, generation: u64) -> Option<RuntimeSession> {
    let mut inner = manager.inner.lock().ok()?;
    if inner.sessions.get(id).map(|session| session.generation) == Some(generation) {
        inner.sessions.remove(id)
    } else {
        None
    }
}

fn stop_session(mut session: RuntimeSession) {
    session.closed.store(true, Ordering::Release);
    close_companion(&session.companion);
    kill_tree(&mut session);
}

#[tauri::command]
pub fn pi_open(
    app: AppHandle,
    state: State<'_, PiRuntimeManager>,
    mut request: PiOpenRequest,
) -> Result<PiOpenResult, String> {
    if !valid_identifier(&request.id, 512)
        || !valid_identifier(&request.widget_id, 256)
        || !valid_identifier(&request.attachment_id, 256)
        || request.open_epoch == 0
        || request.open_epoch > MAX_SAFE_INTEGER
        || !valid_text(&request.cwd, 8192)
    {
        return Err("Invalid managed Pi runtime/widget identity or working directory".into());
    }
    let launch = LaunchIdentity {
        requested_cwd: request.cwd.clone(),
    };
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Pi runtime state poisoned")?;
    if let Some(session) = inner.sessions.get_mut(&request.id) {
        if matches!(session.child.try_wait(), Ok(None)) {
            if request.open_epoch < session.open_epoch {
                return Err("Managed Pi open was superseded by a newer attachment".into());
            }
            if session.launch != launch || session.widget_id != request.widget_id {
                return Err(
                    "Managed Pi runtime identity or working directory changed; stop it before reusing it"
                        .into(),
                );
            }
            session
                .master
                .resize(PtySize {
                    rows: request.rows.max(1),
                    cols: request.cols.max(1),
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| e.to_string())?;
            session.attachment_id = request.attachment_id.clone();
            session.open_epoch = request.open_epoch;
            session.pump.lock().unwrap().live = false;
            let connected = prepare_reattach(session);
            return Ok(PiOpenResult {
                reattached: true,
                generation: session.generation,
                companion_connected: connected,
            });
        }
        if let Some(dead) = inner.sessions.remove(&request.id) {
            stop_session(dead);
        }
    }

    // Filesystem/model validation is spawn-only. A live process no longer
    // needs its original cwd or session file to exist in order to reattach.
    request.cwd = working_directory(&request.cwd)?;
    validate_model_part(&request.provider, "provider")?;
    validate_model_part(&request.model, "model")?;
    validate_thinking_level(&request.thinking_level)?;
    let session_file = exact_session_file(request.session_file.clone())?;

    let generation = inner
        .generations
        .get(&request.id)
        .copied()
        .unwrap_or(0)
        .checked_add(1)
        .ok_or("Pi runtime generation exhausted")?;
    inner.generations.insert(request.id.clone(), generation);

    let listener =
        TcpListener::bind((IpAddr::from([127, 0, 0, 1]), 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = capability_token()?;
    let command = build_command(
        &app,
        &request,
        port,
        &token,
        generation,
        session_file.as_deref(),
    )?;
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: request.rows.max(1),
            cols: request.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| e.to_string())?;
    let Some(child_pid) = child.process_id() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Managed Pi child has no process id".into());
    };
    drop(pair.slave);
    let mut reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.to_string());
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.to_string());
        }
    };
    let pump = Arc::new(Mutex::new(Pump {
        live: false,
        scrollback: Vec::new(),
    }));
    let companion = Arc::new(Mutex::new(CompanionState::default()));
    let closed = Arc::new(AtomicBool::new(false));
    let id = request.id.clone();

    inner.sessions.insert(
        id.clone(),
        RuntimeSession {
            generation,
            widget_id: request.widget_id.clone(),
            attachment_id: request.attachment_id.clone(),
            open_epoch: request.open_epoch,
            launch,
            root_pid: child_pid,
            master: pair.master,
            writer: Arc::new(Mutex::new(writer)),
            child,
            pump: pump.clone(),
            companion: companion.clone(),
            closed: closed.clone(),
        },
    );
    drop(inner);

    let endpoint = CompanionEndpoint {
        app: app.clone(),
        runtime_id: id.clone(),
        widget_id: request.widget_id.clone(),
        generation,
        token,
        child_pid,
        companion,
        closed,
    };
    if let Err(error) = std::thread::Builder::new()
        .name(format!("pi-companion-{generation}"))
        .spawn(move || companion_listener(endpoint, listener))
    {
        if let Some(session) = remove_session(&state, &id, generation) {
            stop_session(session);
        }
        return Err(error.to_string());
    }

    let app_reader = app.clone();
    let id_reader = id.clone();
    if let Err(error) = std::thread::Builder::new()
        .name(format!("pi-pty-{generation}"))
        .spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) => break,
                    Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                    Err(_) => break,
                    Ok(count) => {
                        let emit = {
                            let mut state = pump.lock().unwrap();
                            state.scrollback.extend_from_slice(&chunk[..count]);
                            if state.scrollback.len() > SCROLLBACK_CAP {
                                trim_scrollback(&mut state.scrollback);
                            }
                            state.live
                        };
                        if emit {
                            let _ = app_reader.emit(
                                "pi:pty-data",
                                PiPtyData {
                                    id: id_reader.clone(),
                                    generation,
                                    bytes: chunk[..count].to_vec(),
                                },
                            );
                        }
                    }
                }
            }
            if let Some(manager) = app_reader.try_state::<PiRuntimeManager>() {
                if let Some(session) = remove_session(&manager, &id_reader, generation) {
                    stop_session(session);
                    let _ = app_reader.emit(
                        "pi:exit",
                        PiExit {
                            id: id_reader,
                            generation,
                        },
                    );
                }
            }
        })
    {
        if let Some(session) = remove_session(&state, &id, generation) {
            stop_session(session);
        }
        return Err(error.to_string());
    }

    Ok(PiOpenResult {
        reattached: false,
        generation,
        companion_connected: false,
    })
}

#[tauri::command]
pub fn pi_start(
    app: AppHandle,
    state: State<'_, PiRuntimeManager>,
    id: String,
    generation: u64,
    attachment_id: String,
) {
    let runtime = state.inner.lock().ok().and_then(|inner| {
        inner
            .sessions
            .get(&id)
            .filter(|session| {
                session.generation == generation && session.attachment_id == attachment_id
            })
            .map(|session| (session.pump.clone(), session.companion.clone()))
    });
    let Some((pump, companion)) = runtime else {
        return;
    };
    // Emit replay while holding each channel's lock, then enable live output.
    // Producers cannot emit a newer item before replay reaches the webview.
    let mut pump = pump.lock().unwrap();
    if !pump.scrollback.is_empty() {
        let _ = app.emit(
            "pi:pty-data",
            PiPtyData {
                id: id.clone(),
                generation,
                bytes: pump.scrollback.clone(),
            },
        );
    }
    pump.live = true;
    drop(pump);

    let mut companion = companion.lock().unwrap();
    // Reattach receives only a reconstructible current-state snapshot. Historical
    // deltas remain in the bounded process replay buffer for companion reconnect,
    // but replaying them to the UI would duplicate metrics and notifications.
    let mut snapshots = [
        companion.session_snapshot.clone(),
        companion.lifecycle_snapshot.clone(),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    snapshots.sort_by_key(|frame| frame.get("seq").and_then(Value::as_u64).unwrap_or(0));
    for frame in snapshots {
        let _ = app.emit(
            "pi:companion",
            CompanionData {
                id: id.clone(),
                generation,
                replayed: true,
                frame,
            },
        );
    }
    companion.live = true;
}

#[tauri::command]
pub fn pi_write(
    state: State<'_, PiRuntimeManager>,
    id: String,
    generation: u64,
    attachment_id: String,
    data: String,
) -> Result<(), String> {
    if data.len() > MAX_FRAME_BYTES {
        return Err("Pi terminal input exceeds bound".into());
    }
    let writer = {
        let inner = state
            .inner
            .lock()
            .map_err(|_| "Pi runtime state poisoned")?;
        inner
            .sessions
            .get(&id)
            .filter(|session| {
                session.generation == generation && session.attachment_id == attachment_id
            })
            .map(|session| session.writer.clone())
            .ok_or("Managed Pi runtime is not active")?
    };
    let mut writer = writer.lock().map_err(|_| "Pi terminal writer poisoned")?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pi_resize(
    state: State<'_, PiRuntimeManager>,
    id: String,
    generation: u64,
    attachment_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "Pi runtime state poisoned")?;
    let Some(session) = inner.sessions.get(&id).filter(|session| {
        session.generation == generation && session.attachment_id == attachment_id
    }) else {
        return Err("Managed Pi runtime is not active".into());
    };
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pi_detach(
    state: State<'_, PiRuntimeManager>,
    id: String,
    generation: u64,
    attachment_id: String,
) {
    if let Ok(inner) = state.inner.lock() {
        if let Some(session) = inner.sessions.get(&id).filter(|session| {
            session.generation == generation && session.attachment_id == attachment_id
        }) {
            session.pump.lock().unwrap().live = false;
            session.companion.lock().unwrap().live = false;
        }
    }
}

#[tauri::command]
pub fn pi_control(
    state: State<'_, PiRuntimeManager>,
    id: String,
    generation: u64,
    attachment_id: String,
    request_id: String,
    control: PiControl,
) -> Result<(), String> {
    if !valid_identifier(&request_id, 256) {
        return Err("Invalid Pi control request id".into());
    }
    let control = match control {
        PiControl::Prompt { text, deliver_as } => {
            if !valid_text(&text, MAX_FRAME_BYTES / 2)
                || deliver_as
                    .as_deref()
                    .is_some_and(|value| !matches!(value, "steer" | "followUp"))
            {
                return Err("Invalid Pi prompt control".into());
            }
            json!({ "type": "prompt", "text": text, "deliverAs": deliver_as })
        }
        PiControl::Abort => json!({ "type": "abort" }),
        PiControl::Rename { name } => {
            if !valid_text(&name, 1024) {
                return Err("Invalid Pi rename control".into());
            }
            json!({ "type": "rename", "name": name })
        }
        PiControl::Shutdown => json!({ "type": "shutdown" }),
    };
    let (widget_id, companion) = {
        let inner = state
            .inner
            .lock()
            .map_err(|_| "Pi runtime state poisoned")?;
        let session = inner
            .sessions
            .get(&id)
            .filter(|session| {
                session.generation == generation && session.attachment_id == attachment_id
            })
            .ok_or("Managed Pi runtime is not active")?;
        (session.widget_id.clone(), session.companion.clone())
    };
    // Never perform socket I/O while holding the global runtime map. The
    // per-companion lock serializes frames, and the socket write timeout keeps
    // a non-reading extension from making kill/detach globally unresponsive.
    let mut companion = companion.lock().map_err(|_| "Companion state poisoned")?;
    if !companion.authenticated {
        return Err("Managed Pi companion is not connected".into());
    }
    let frame = json!({
        "v": PROTOCOL_VERSION,
        "type": "control",
        "widgetId": widget_id,
        "generation": generation,
        "requestId": request_id,
        "control": control,
    });
    let mut encoded = serde_json::to_vec(&frame).map_err(|e| e.to_string())?;
    encoded.push(b'\n');
    if encoded.len() > MAX_FRAME_BYTES {
        return Err("Pi control frame exceeds bound".into());
    }
    let writer = companion
        .writer
        .as_mut()
        .ok_or("Managed Pi companion is not writable")?;
    writer.write_all(&encoded).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pi_kill(
    state: State<'_, PiRuntimeManager>,
    id: String,
    generation: u64,
    attachment_id: String,
) {
    let session = state.inner.lock().ok().and_then(|mut inner| {
        if inner.sessions.get(&id).is_some_and(|session| {
            session.generation == generation && session.attachment_id == attachment_id
        }) {
            inner.sessions.remove(&id)
        } else {
            None
        }
    });
    if let Some(session) = session {
        stop_session(session);
    }
}

/// Delete-path fallback for a restored hidden tab whose webview has not yet
/// learned the backend generation. Runtime IDs are workspace-instance scoped.
#[tauri::command]
pub fn pi_kill_current(state: State<'_, PiRuntimeManager>, id: String, delete_epoch: u64) {
    let session = state.inner.lock().ok().and_then(|mut inner| {
        if inner
            .sessions
            .get(&id)
            .is_some_and(|session| session.open_epoch < delete_epoch)
        {
            inner.sessions.remove(&id)
        } else {
            None
        }
    });
    if let Some(session) = session {
        stop_session(session);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(unix)]
    fn capabilities_are_random_url_safe_and_fixed_strength() {
        let first = capability_token().unwrap();
        let second = capability_token().unwrap();
        assert_eq!(first.len(), 43);
        assert_eq!(second.len(), 43);
        assert_ne!(first, second);
        assert!(first
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_')));
    }

    #[test]
    fn capability_comparison_and_runtime_identity_fail_closed() {
        assert!(constant_time_eq("same", "same"));
        assert!(!constant_time_eq("same", "different"));
        assert!(!constant_time_eq("same", "samp"));
        let hello = json!({
            "v": 1,
            "type": "hello",
            "widgetId": "widget",
            "generation": 2,
            "token": "secret",
            "pid": 42,
        });
        let encoded = serde_json::to_vec(&hello).unwrap();
        assert!(authenticate(&encoded, "widget", 2, "secret", 42).is_ok());
        assert!(authenticate(&encoded, "widget", 3, "secret", 42).is_err());
        assert!(authenticate(&encoded, "widget", 2, "wrong", 42).is_err());
        assert!(authenticate(&encoded, "widget", 2, "secret", 43).is_err());
    }

    #[test]
    fn model_arguments_preserve_provider_only_configuration() {
        let mut provider_only = CommandBuilder::new("pi");
        append_model_args(&mut provider_only, Some("anthropic"), None);
        assert_eq!(
            provider_only.get_argv(),
            &vec![
                std::ffi::OsString::from("pi"),
                std::ffi::OsString::from("--provider"),
                std::ffi::OsString::from("anthropic"),
            ]
        );

        let mut combined = CommandBuilder::new("pi");
        append_model_args(&mut combined, Some("anthropic"), Some("sonnet"));
        assert_eq!(
            combined.get_argv(),
            &vec![
                std::ffi::OsString::from("pi"),
                std::ffi::OsString::from("--model"),
                std::ffi::OsString::from("anthropic/sonnet"),
            ]
        );
    }

    #[test]
    fn inherited_environment_is_rebuilt_without_parent_runtime_identity() {
        let mut command = CommandBuilder::new("pi");
        command.env("CMUX_WORKSPACE_ID", "leak");
        command.env("CCANVAS_COMPANION_TOKEN", "leak");
        command.env("PI_SESSION_ID", "leak");
        command.env("PI_MODEL", "leak");
        inherited_env(&mut command);
        assert!(command.get_env("CMUX_WORKSPACE_ID").is_none());
        assert!(command.get_env("CCANVAS_COMPANION_TOKEN").is_none());
        assert!(command.get_env("PI_SESSION_ID").is_none());
        assert!(command.get_env("PI_MODEL").is_none());
        assert_eq!(command.get_env("TERM").unwrap(), "xterm-256color");
        assert_eq!(command.get_env("COLORTERM").unwrap(), "truecolor");
    }

    #[test]
    fn native_host_decoder_rejects_malformed_reflected_and_token_frames() {
        let valid = json!({
            "v": 1,
            "type": "event",
            "widgetId": "widget",
            "generation": 2,
            "seq": 0,
            "event": { "type": "session", "phase": "start", "sessionId": "session" },
        });
        assert!(decode_host_frame(&serde_json::to_vec(&valid).unwrap(), "widget", 2).is_ok());

        let unicode_boundary = json!({
            "v": 1, "type": "event", "widgetId": "widget", "generation": 2, "seq": 1,
            "event": { "type": "session", "phase": "info", "name": "😀".repeat(256) },
        });
        assert!(
            decode_host_frame(&serde_json::to_vec(&unicode_boundary).unwrap(), "widget", 2).is_ok()
        );
        let mut unicode_oversized = unicode_boundary.clone();
        unicode_oversized["event"]["name"] = Value::String("😀".repeat(257));
        assert!(decode_host_frame(
            &serde_json::to_vec(&unicode_oversized).unwrap(),
            "widget",
            2
        )
        .is_err());
        let mut carriage_return = unicode_boundary;
        carriage_return["event"]["name"] = Value::String("bad\rname".into());
        assert!(
            decode_host_frame(&serde_json::to_vec(&carriage_return).unwrap(), "widget", 2).is_err()
        );

        let mut malformed = valid.clone();
        malformed["event"] = Value::Null;
        assert!(decode_host_frame(&serde_json::to_vec(&malformed).unwrap(), "widget", 2).is_err());

        let mut leaking = valid.clone();
        leaking["token"] = Value::String("must-not-appear".into());
        assert!(decode_host_frame(&serde_json::to_vec(&leaking).unwrap(), "widget", 2).is_err());

        let reflected = json!({
            "v": 1,
            "type": "control",
            "widgetId": "widget",
            "generation": 2,
            "requestId": "reflected",
            "control": { "type": "abort" },
        });
        assert!(decode_host_frame(&serde_json::to_vec(&reflected).unwrap(), "widget", 2).is_err());
        assert!(decode_host_frame(b"\xff\xfe", "widget", 2).is_err());
    }

    #[test]
    fn native_framer_rejects_truncated_eof() {
        let listener = TcpListener::bind((IpAddr::from([127, 0, 0, 1]), 0)).unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        client.write_all(b"{\"v\":1").unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        let mut buffer = Vec::new();
        assert!(
            matches!(read_frames(&mut server, &mut buffer), Ok(Some(frames)) if frames.is_empty())
        );
        assert_eq!(
            read_frames(&mut server, &mut buffer).unwrap_err(),
            "Truncated companion frame"
        );
    }

    #[test]
    #[cfg(unix)]
    fn stable_launch_group_cleanup_reaps_child_and_descendants() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 10,
                cols: 40,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "sleep 30 & wait"]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        let root = child.process_id().unwrap();
        drop(pair.slave);

        let deadline = Instant::now() + Duration::from_secs(1);
        let descendants = loop {
            let descendants = session_member_pids(root)
                .into_iter()
                .filter(|pid| *pid != root)
                .collect::<Vec<_>>();
            if !descendants.is_empty() || Instant::now() >= deadline {
                break descendants;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(!descendants.is_empty(), "shell did not spawn its child");
        terminate_process_tree(root, child.as_mut());
        assert!(child.try_wait().unwrap().is_some());
        assert!(session_member_pids(root).is_empty());
    }

    #[test]
    fn replay_gap_marks_retained_snapshots_and_reset_as_replayed() {
        let event = json!({ "event": { "type": "lifecycle", "phase": "agent_settled" } });
        let reset = json!({
            "event": {
                "type": "runtime_error",
                "code": "replay_reset_complete",
                "message": "reset"
            }
        });
        let mut state = CompanionState::default();
        assert!(replay_delivery(&mut state, &event, true));
        assert!(replay_delivery(&mut state, &event, false));
        assert!(replay_delivery(&mut state, &reset, false));
        assert!(!state.recovering);
        assert!(!replay_delivery(&mut state, &event, false));
    }

    #[test]
    fn replay_is_bounded_by_count_and_bytes() {
        let mut state = CompanionState::default();
        for seq in 0..(MAX_REPLAY_EVENTS + 4) {
            retain_event(&mut state, json!({ "seq": seq }), 10);
        }
        assert_eq!(state.events.len(), MAX_REPLAY_EVENTS);
        assert_eq!(state.event_bytes, MAX_REPLAY_EVENTS * 10);
        retain_event(&mut state, json!({ "large": true }), MAX_REPLAY_BYTES);
        assert_eq!(state.events.len(), 1);
        assert_eq!(state.event_bytes, MAX_REPLAY_BYTES);
    }

    #[test]
    fn exact_resume_rejects_guesses_and_missing_paths() {
        assert!(exact_session_file(None).unwrap().is_none());
        assert!(exact_session_file(Some("partial-id".into())).is_err());
        assert!(
            exact_session_file(Some("/definitely/missing/ccanvas-session.jsonl".into())).is_err()
        );
    }
}
