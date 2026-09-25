#!/usr/bin/env python3
"""Opt-in startup probe with normal resource discovery; no LLM/tool commands.

Extensions may run their normal startup hooks (including local service connections).
This is NOT an all-extensions compatibility test. It does not approve projects,
change authentication, persist a session, or invoke an extension command.
"""
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
config = json.loads((ROOT / 'fork.config.json').read_text())
launcher = config['piLauncher']
program = shutil.which(launcher['program'])
if not program:
    sys.exit('Pi executable not found on PATH; no installation attempted.')

env = {**os.environ, **launcher['env']}
proc = subprocess.Popen(
    [program, '--mode', 'rpc', '--no-session'], cwd=ROOT, env=env,
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
)
summary = {
    'launcher': launcher['program'],
    'env': launcher['env'],
    'args': ['--mode', 'rpc', '--no-session'],
    'normalResourceDiscovery': True,
    'modelPromptSent': False,
    'responses': {}, 'eventCounts': {}, 'invalidStdoutLines': 0,
    'stderrBytes': 0, 'stderrSignals': [],
}
selector = selectors.DefaultSelector()
for stream, name in [(proc.stdout, 'stdout'), (proc.stderr, 'stderr')]:
    selector.register(stream, selectors.EVENT_READ, name)
buffers = {'stdout': b'', 'stderr': b''}
deadline = time.monotonic() + 40
signalled = False


def consume(raw, name):
    global signalled
    if name == 'stderr':
        text = raw.decode('utf-8', errors='replace').lower()
        for marker in ['dashboard', 'unreachable', 'extension', 'error', 'keychain', 'password']:
            if marker in text and marker not in summary['stderrSignals']:
                summary['stderrSignals'].append(marker)
        if 'keychain' in text or 'password' in text:
            signalled = True  # Stop instead of engaging a credential helper.
        return
    try:
        event = json.loads(raw)
        if not isinstance(event, dict):
            raise ValueError('not an object')
    except (ValueError, UnicodeError):
        summary['invalidStdoutLines'] += 1
        return
    kind = event.get('type', 'unknown')
    summary['eventCounts'][kind] = summary['eventCounts'].get(kind, 0) + 1
    if kind != 'response' or event.get('id') not in ('stage0-state', 'stage0-commands'):
        return
    command = event.get('command')
    data = event.get('data') or {}
    result = {'success': event.get('success', False)}
    if command == 'get_state' and result['success']:
        result.update({
            'hasSessionId': bool(data.get('sessionId')),
            'isStreaming': data.get('isStreaming'),
            'messageCount': data.get('messageCount'),
        })
    if command == 'get_commands' and result['success']:
        result['commands'] = [
            {'name': c.get('name'), 'source': c.get('source')}
            for c in data.get('commands', [])
        ]
    summary['responses'][command] = result


try:
    for ident, command in [('stage0-state', 'get_state'), ('stage0-commands', 'get_commands')]:
        proc.stdin.write((json.dumps({'id': ident, 'type': command}) + '\n').encode())
    proc.stdin.flush()
    while selector.get_map() and time.monotonic() < deadline and not signalled:
        for key, _ in selector.select(timeout=min(1, max(0, deadline - time.monotonic()))):
            chunk = os.read(key.fileobj.fileno(), 65536)
            name = key.data
            if not chunk:
                selector.unregister(key.fileobj)
                if buffers[name]:
                    consume(buffers[name], name)
                    buffers[name] = b''
                continue
            if name == 'stderr':
                summary['stderrBytes'] += len(chunk)
            buffers[name] += chunk
            if len(buffers[name]) > 4 * 1024 * 1024:
                raise RuntimeError('Probe frame limit exceeded')
            while b'\n' in buffers[name]:
                line, buffers[name] = buffers[name].split(b'\n', 1)
                consume(line.rstrip(b'\r'), name)
        if len(summary['responses']) == 2:
            break
    summary['complete'] = (
        len(summary['responses']) == 2
        and all(r['success'] for r in summary['responses'].values())
        and summary['invalidStdoutLines'] == 0
        and not signalled
    )
    summary['credentialPromptDetected'] = signalled
finally:
    proc.stdin.close()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
    selector.close()
    proc.stdout.close()
    proc.stderr.close()

print(json.dumps(summary, indent=2))
sys.exit(0 if summary.get('complete') else 1)
