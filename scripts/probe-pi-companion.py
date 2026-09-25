#!/usr/bin/env python3
"""Opt-in native Pi companion probe using only synthetic private sessions.

Loads normal Pi resources plus the production companion and stage-0 UI observer.
Exercises authentication, session metadata, rename/idle-abort controls, native
custom UI cancellation and graceful shutdown. Sends no model prompt or tool call.
"""
import fcntl
import hmac
import json
import os
from pathlib import Path
import pty
import re
import select
import secrets
import shutil
import signal
import socket
import struct
import sys
import tempfile
import termios
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
ANSI = re.compile(rb'\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]')
MAX_FRAME = 256 * 1024


def main():
    config = json.loads((ROOT / 'fork.config.json').read_text())
    program = shutil.which(config['piLauncher']['program'])
    if not program:
        raise RuntimeError('Pi is not installed; no installation attempted')
    (ROOT / '.stage0').mkdir(exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='companion-', dir=ROOT / '.stage0'))
    observer = run / 'observer.jsonl'
    observer.touch(mode=0o600)
    session = run / 'synthetic-session.jsonl'
    session_id = str(uuid.uuid4())
    timestamp = '2026-09-24T00:00:00.000Z'
    seed = [
        {'type': 'session', 'version': 3, 'id': session_id, 'timestamp': timestamp, 'cwd': str(ROOT)},
        {'type': 'message', 'id': '00000001', 'parentId': None, 'timestamp': timestamp,
         'message': {'role': 'user', 'content': 'Synthetic fixture only; do not execute.', 'timestamp': 0}},
        {'type': 'message', 'id': '00000002', 'parentId': '00000001', 'timestamp': timestamp,
         'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'Synthetic fixture, not a model response.'}],
                     'api': 'openai-responses', 'provider': 'openai', 'model': 'fixture', 'timestamp': 0,
                     'stopReason': 'stop', 'usage': {**dict.fromkeys(['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'], 0),
                     'cost': dict.fromkeys(['input', 'output', 'cacheRead', 'cacheWrite', 'total'], 0)}}},
    ]
    with session.open('x') as stream:
        os.chmod(session, 0o600)
        stream.write(''.join(json.dumps(event) + '\n' for event in seed))

    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
    listener.bind(('127.0.0.1', 0))
    listener.listen(1)
    listener.setblocking(False)
    port = listener.getsockname()[1]
    token = secrets.token_urlsafe(32)
    widget_id = f'synthetic-widget-{uuid.uuid4()}'
    generation = 1

    env = {**os.environ, **config['piLauncher']['env']}
    for key in list(env):
        if key.startswith('CMUX_') or key in ('PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL'):
            del env[key]
    env.update(
        TERM='xterm-256color', COLORTERM='truecolor', PI_OFFLINE='1',
        CCANVAS_PROBE_LOG=str(observer), CCANVAS_PROBE_SESSION=str(session),
        CCANVAS_COMPANION_HOST='127.0.0.1', CCANVAS_COMPANION_PORT=str(port),
        CCANVAS_COMPANION_TOKEN=token, CCANVAS_COMPANION_WIDGET_ID=widget_id,
        CCANVAS_COMPANION_GENERATION=str(generation),
    )
    argv = [
        program, '--session', str(session), '--session-dir', str(run),
        '-e', str(ROOT / 'scripts/pi-companion-extension.ts'),
        '-e', str(ROOT / 'scripts/pi-tui-probe-extension.ts'),
    ]
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(ROOT)
        os.execve(program, argv, env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 48, 140, 0, 0))

    connection = None
    network_buffer = b''
    terminal = b''
    frames = []
    reaped = False
    status = None
    report = {'syntheticSession': True, 'modelPromptSent': False, 'toolCallSent': False, 'checks': []}

    def observer_events():
        return [json.loads(line) for line in observer.read_text().splitlines() if line]

    def send(frame):
        payload = (json.dumps(frame, separators=(',', ':')) + '\n').encode()
        if len(payload) > MAX_FRAME:
            raise RuntimeError('Probe attempted oversized host frame')
        connection.sendall(payload)

    def pump(timeout=.1):
        nonlocal connection, network_buffer, terminal, reaped, status
        reads = [fd, listener]
        if connection:
            reads.append(connection)
        for ready in select.select(reads, [], [], timeout)[0]:
            if ready is listener:
                if connection:
                    raise RuntimeError('Companion opened more than one connection')
                connection, address = listener.accept()
                if address[0] != '127.0.0.1':
                    raise RuntimeError('Non-loopback companion connection')
                connection.setblocking(False)
            elif ready == fd:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    chunk = b''
                combined = terminal[-16:] + chunk
                if b'\x1b[6n' in combined:
                    os.write(fd, b'\x1b[1;1R')
                terminal = (terminal + chunk)[-1024 * 1024:]
            else:
                chunk = connection.recv(65536)
                if not chunk:
                    connection.close()
                    connection = None
                    continue
                network_buffer += chunk
                if len(network_buffer) > MAX_FRAME and b'\n' not in network_buffer:
                    raise RuntimeError('Unterminated companion frame exceeded bound')
                while b'\n' in network_buffer:
                    raw, network_buffer = network_buffer.split(b'\n', 1)
                    if not raw or len(raw) > MAX_FRAME:
                        raise RuntimeError('Invalid companion frame bound')
                    frames.append(json.loads(raw))
        if not reaped:
            child, result = os.waitpid(pid, os.WNOHANG)
            if child:
                reaped, status = True, result
        plain = ANSI.sub(b'', terminal).lower()
        if any(marker in plain for marker in [b'keychain', b'password:', b'trust this project']):
            raise RuntimeError('Unexpected credential/trust prompt; stopped unanswered')
        if any(event['type'] in ('unexpected_input', 'unexpected_agent_start') for event in observer_events()):
            raise RuntimeError('Unexpected model input/activity')

    def wait_for(predicate, label, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            pump()
            value = predicate()
            if value:
                return value
            if reaped:
                raise RuntimeError(f'Pi exited before {label}')
        raise RuntimeError(f'Timed out waiting for {label}')

    def command(text):
        nonlocal terminal
        deadline = time.monotonic() + .4
        while time.monotonic() < deadline:
            pump(min(.1, deadline - time.monotonic()))
        terminal = b''
        start = len(observer_events())
        os.write(fd, b'\x1b[200~' + text.encode() + b'\x1b[201~\r')
        return start

    try:
        hello = wait_for(lambda: next((frame for frame in frames if frame.get('type') == 'hello'), None), 'companion hello', 40)
        if hello.get('v') != 1 or hello.get('widgetId') != widget_id or hello.get('generation') != generation:
            raise RuntimeError('Companion hello identity mismatch')
        if not hmac.compare_digest(hello.get('token', ''), token):
            raise RuntimeError('Companion capability mismatch')
        send({'v': 1, 'type': 'welcome', 'widgetId': widget_id, 'generation': generation, 'replayFrom': 0})
        session_frame = wait_for(lambda: next((frame for frame in frames
            if frame.get('type') == 'event' and frame.get('event', {}).get('type') == 'session'
            and frame.get('event', {}).get('phase') == 'start'), None), 'session event')
        if session_frame['event'].get('sessionId') != session_id or session_frame['event'].get('sessionFile') != str(session):
            raise RuntimeError('Companion did not report exact synthetic session')
        wait_for(lambda: any(event['type'] == 'session_start' for event in observer_events()), 'native observer startup')
        report['checks'].append('capability hello and exact synthetic session')

        send({'v': 1, 'type': 'control', 'widgetId': widget_id, 'generation': generation,
              'requestId': 'rename-1', 'control': {'type': 'rename', 'name': 'synthetic companion'}})
        send({'v': 1, 'type': 'control', 'widgetId': widget_id, 'generation': generation,
              'requestId': 'abort-1', 'control': {'type': 'abort'}})
        wait_for(lambda: all(any(frame.get('type') == 'result' and frame.get('requestId') == request and frame.get('ok')
                                 for frame in frames) for request in ('rename-1', 'abort-1')), 'control results')
        wait_for(lambda: any(frame.get('type') == 'event' and frame.get('event', {}).get('type') == 'session'
                             and frame.get('event', {}).get('name') == 'synthetic companion' for frame in frames), 'rename metadata')
        report['checks'].append('rename and idle abort controls acknowledged')

        start = command('/ccanvas-probe custom')
        wait_for(lambda: b'CCANVAS PROBE: Escape cancels' in ANSI.sub(b'', terminal), 'native custom overlay')
        os.write(fd, b'\x1b')
        wait_for(lambda: any(event['type'] == 'custom_result' and event.get('result') == 'cancelled'
                             for event in observer_events()[start:]), 'native overlay cancellation')
        report['checks'].append('native custom UI remains active')

        command('/ccanvas-probe quit')
        wait_for(lambda: any(frame.get('type') == 'event' and frame.get('event', {}).get('type') == 'session'
                             and frame.get('event', {}).get('phase') == 'shutdown' for frame in frames), 'shutdown event')
        wait_for(lambda: reaped, 'Pi exit', 10)
        if os.waitstatus_to_exitcode(status) != 0:
            raise RuntimeError('Pi did not exit cleanly')
        report['checks'].append('structured shutdown and clean Pi exit')
        report['eventTypes'] = sorted({frame.get('event', {}).get('type') for frame in frames if frame.get('type') == 'event'})
        report['complete'] = True
    except Exception as error:
        report['complete'] = False
        report['failure'] = str(error)
    finally:
        if not reaped:
            try:
                os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                child, status = os.waitpid(pid, os.WNOHANG)
                if child:
                    reaped = True
                    break
                time.sleep(.05)
            if not reaped:
                os.killpg(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
        os.close(fd)
        if connection:
            connection.close()
        listener.close()
    (run / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    print('Local evidence:', run.relative_to(ROOT), file=sys.stderr)
    return 0 if report.get('complete') else 1


if __name__ == '__main__':
    sys.exit(main())
