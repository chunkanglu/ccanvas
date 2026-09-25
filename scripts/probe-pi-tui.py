#!/usr/bin/env python3
"""Opt-in POSIX PTY test: normal Pi discovery + a metadata-only test extension.

No model prompts, tool calls, credential helpers or approval clicks. Normal
extension startup hooks still run. Sessions are SYNTHETIC test fixtures under
.stage0/, never the user's real conversations. No raw terminal output is saved.
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import sys
import tempfile
import termios
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
ANSI = re.compile(rb'\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]')


def main():
    config = json.loads((ROOT / 'fork.config.json').read_text())
    program = shutil.which(config['piLauncher']['program'])
    if not program:
        raise RuntimeError('Pi is not installed; no installation attempted')
    (ROOT / '.stage0').mkdir(exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='tui-', dir=ROOT / '.stage0'))
    events_file = run / 'events.jsonl'
    events_file.touch(mode=0o600)
    session = run / 'synthetic-session.jsonl'
    session_id = str(uuid.uuid4())
    # Explicitly synthetic prior conversation: validates resume, not model output.
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
    with session.open('x') as f:
        os.chmod(session, 0o600)
        f.write(''.join(json.dumps(e) + '\n' for e in seed))
    env = {**os.environ, **config['piLauncher']['env']}
    # A new canvas-owned PTY must not impersonate its parent's host surface/session.
    removed = []
    for key in list(env):
        if key.startswith('CMUX_') or key in ('PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL'):
            removed.append(key)
            del env[key]
    env.update(TERM='xterm-256color', COLORTERM='truecolor', PI_OFFLINE='1',
               CCANVAS_PROBE_LOG=str(events_file), CCANVAS_PROBE_SESSION=str(session))
    argv = [program, '--session', str(session), '--session-dir', str(run),
            '-e', str(ROOT / 'scripts/pi-tui-probe-extension.ts')]
    report = {'checks': [], 'normalResourceDiscovery': True, 'modelPromptSent': False,
              'syntheticSession': True, 'startupOffline': True, 'removedHostEnvKeys': sorted(removed)}
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(ROOT)
        os.execve(program, argv, env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 48, 140, 0, 0))
    output = b''
    reaped = False
    status = None

    def events():
        return [json.loads(line) for line in events_file.read_text().split('\n') if line]

    def pump(timeout=.1):
        nonlocal output, reaped, status
        if select.select([fd], [], [], timeout)[0]:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                chunk = b''
            # Answer standard terminal cursor-position requests; not UI approvals.
            combined = output[-16:] + chunk
            if b'\x1b[6n' in combined:
                os.write(fd, b'\x1b[1;1R')
            output = (output + chunk)[-1024 * 1024:]
        if not reaped:
            child, result = os.waitpid(pid, os.WNOHANG)
            if child:
                reaped, status = True, result
        plain = ANSI.sub(b'', output).lower()
        if any(s in plain for s in [b'keychain', b'password:', b'trust this project']):
            raise RuntimeError('Unexpected credential/trust prompt; stopped without answering')
        if any(e['type'] in ('unexpected_input', 'unexpected_agent_start') for e in events()):
            raise RuntimeError('Unexpected non-command input/model activity; stopping')

    def wait_for(predicate, label, timeout=25):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            pump()
            value = predicate()
            if value:
                return value
            if reaped:
                raise RuntimeError(f'Pi exited before {label}')
        raise RuntimeError(f'Timed out waiting for {label}')

    def since(index, kind):
        return next((e for e in events()[index:] if e['type'] == kind), None)

    def settle_ui():
        # A bare Escape is ambiguous until Pi's input debounce expires. Drain
        # render/input work before sending another command (not a model wait).
        deadline = time.monotonic() + .4
        while time.monotonic() < deadline:
            pump(min(.1, deadline - time.monotonic()))

    def command(text):
        nonlocal output
        settle_ui()
        output = b''
        index = len(events())
        # Bracketed paste prevents punctuation/control interpretation in commands.
        os.write(fd, b'\x1b[200~' + text.encode() + b'\x1b[201~')
        pump(.1)
        os.write(fd, b'\r')
        return index

    def snapshot():
        index = command('/ccanvas-probe snapshot')
        return wait_for(lambda: since(index, 'snapshot'), 'snapshot')

    try:
        initial = wait_for(lambda: since(0, 'session_start'), 'native startup', 40)
        assert initial['mode'] == 'tui' and initial['hasUI'] is True
        assert initial['sessionId'] == session_id
        assert initial['idleTimeout'] == '6000000'
        # session_start precedes editor readiness; wait for the synthetic message.
        wait_for(lambda: b'Synthetic fixture, not a model response.' in ANSI.sub(b'', output), 'initial render')
        initial = snapshot()
        report['checks'].append('native startup and exact fixture resume')
        report['extensionCommands'] = initial['commands']
        report['activeTools'] = initial['activeTools']

        index = command('/ccanvas-probe custom')
        wait_for(lambda: b'CCANVAS PROBE: Escape cancels' in ANSI.sub(b'', output), 'custom overlay render')
        os.write(fd, b'\x1b')
        result = wait_for(lambda: since(index, 'custom_result'), 'custom overlay cancellation')
        assert result['result'] == 'cancelled'
        report['checks'].append('custom TUI overlay rendered and Escape cancelled')

        index = command('/ccanvas-probe confirm')
        wait_for(lambda: b'Select No or Escape' in ANSI.sub(b'', output), 'confirm render')
        os.write(fd, b'\x1b')
        result = wait_for(lambda: since(index, 'confirm_result'), 'confirm cancellation')
        assert result['result'] is False
        report['checks'].append('installed UI stack confirmation rendered and Escape denied')

        assert 'intercom' in initial['commands']
        command('/intercom')
        wait_for(lambda: b'Current Session' in ANSI.sub(b'', output) and b'Other Sessions' in ANSI.sub(b'', output), 'intercom overlay')
        os.write(fd, b'\x1b')
        pump(.2)
        snapshot()
        report['checks'].append('installed intercom overlay opened and closed without messaging')

        index = command('/ccanvas-probe mark')
        wait_for(lambda: since(index, 'marked'), 'fixture marker')
        index = command('/ccanvas-probe new')
        new = wait_for(lambda: since(index, 'session_start'), 'new session', 40)
        assert new['reason'] == 'new' and new['sessionId'] != session_id
        index = command('/ccanvas-probe switch')
        restored = wait_for(lambda: since(index, 'session_start'), 'switch to fixture', 40)
        assert restored['reason'] == 'resume' and restored['sessionId'] == session_id and restored['markerRestored']
        report['checks'].append('new/switch lifecycle and persisted extension marker restored')
        index = command('/ccanvas-probe fork')
        forked = wait_for(lambda: since(index, 'session_start'), 'clone fixture', 40)
        assert forked['reason'] == 'fork' and forked['sessionId'] != session_id and forked['markerRestored']
        report['checks'].append('clone has distinct identity and preserves extension marker')
        command('/ccanvas-probe quit')
        wait_for(lambda: reaped, 'graceful exit', 10)
        assert os.waitstatus_to_exitcode(status) == 0
        report['checks'].append('graceful shutdown')
        report['complete'] = True
    except Exception as error:
        report['complete'] = False
        report['failure'] = str(error)
        # Diagnostic presence flags only; never print peer names or terminal text.
        plain = ANSI.sub(b'', output)
        report['terminalSignals'] = {label: marker in plain for label, marker in {
            'intercomOverlay': b'Other Sessions', 'snapshotTyped': b'ccanvas-probe snapshot',
            'composeOverlay': b'Send message', 'error': b'Error',
        }.items()}
    finally:
        if not reaped:
            os.killpg(pid, signal.SIGTERM)
            end = time.monotonic() + 5
            while time.monotonic() < end:
                child, status = os.waitpid(pid, os.WNOHANG)
                if child:
                    reaped = True
                    break
                select.select([fd], [], [], .1)
                try:
                    if select.select([fd], [], [], 0)[0]: os.read(fd, 65536)
                except OSError:
                    pass
            if not reaped:
                os.killpg(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
        os.close(fd)
    report['eventCounts'] = {kind: sum(e['type'] == kind for e in events()) for kind in sorted({e['type'] for e in events()})}
    (run / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    print('Local evidence:', run.relative_to(ROOT), file=sys.stderr)
    return 0 if report['complete'] else 1


if __name__ == '__main__':
    sys.exit(main())
