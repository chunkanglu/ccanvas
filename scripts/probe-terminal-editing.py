#!/usr/bin/env python3
"""POSIX/zsh regression probe: real PTY -> installed xterm parser.

Uses a clean shell, private ZDOTDIR, synthetic ASCII input and zsh's print builtin.
No user shell config, model requests, package installs or raw transcript logging.
This verifies terminal bytes/buffer, not the graphical renderer or Tauri IPC.
"""
import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = 'abcdefghijklmnopqrstuvwXYZ'
PREFIX = 'print -r -- '


def probe(zsh, zdotdir, term):
    env = dict(os.environ)
    for key in list(env):
        if key.startswith('CMUX_') or key in ('TERM', 'COLORTERM', 'TERMCAP', 'PI_SESSION_ID', 'PI_SESSION_FILE'):
            env.pop(key, None)
    env.update(ZDOTDIR=zdotdir, PS1='probe> ', PROMPT='probe> ', RPS1='', RPROMPT='')
    if term:
        env.update(TERM=term, COLORTERM='truecolor')
    parser = subprocess.Popen(['node', str(ROOT / 'tests/helpers/terminal-parser.mjs')],
                              cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(ROOT)
        os.execve(zsh, [zsh, '-d', '-f'], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
    buffer = b''
    state = {}

    def pump(timeout=.02):
        nonlocal buffer, state
        ready = select.select([fd, parser.stdout], [], [], max(0, timeout))[0]
        if fd in ready:
            chunk = os.read(fd, 65536)
            if not chunk:
                raise RuntimeError('Shell exited early')
            parser.stdin.write((json.dumps({'data': base64.b64encode(chunk).decode()}) + '\n').encode())
            parser.stdin.flush()
        if parser.stdout in ready:
            chunk = os.read(parser.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError('xterm parser exited early')
            buffer += chunk
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                record = json.loads(line)
                if 'reply' in record:
                    os.write(fd, record['reply'].encode())
                else:
                    state = record

    def wait_until(predicate, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            pump()
            if predicate():
                return
        raise RuntimeError('Timed out waiting for test shell output')

    def drain(seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            pump(min(.02, deadline - time.monotonic()))

    try:
        wait_until(lambda: state.get('current', '').strip() == 'probe>')
        keys = (PREFIX + 'abcdefghijklmnopqrstuvwxyz').encode() + b'\x7f\x7f\x7fXYZ'
        for key in keys:
            os.write(fd, bytes([key]))
            drain(.025)
        drain(.25)
        expected_line = 'probe> ' + PREFIX + EXPECTED
        display_correct = state.get('current', '').rstrip() == expected_line
        cursor_correct = state.get('cursorX') == len(expected_line)
        # Execute only the synthetic zsh print builtin, to check actual editing
        # independently of what xterm was asked to display.
        os.write(fd, b'\r')
        wait_until(lambda: EXPECTED in [line.strip() for line in state.get('lines', [])]
                   and state.get('current', '').strip() == 'probe>')
        return {'TERM': term, 'displayCorrect': display_correct,
                'cursorCorrect': cursor_correct, 'commandResultCorrect': True}
    finally:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
        os.close(fd)
        parser.stdin.close()
        try:
            parser.wait(timeout=3)
        except subprocess.TimeoutExpired:
            parser.kill()
            parser.wait()
        parser.stdout.close()


def main():
    zsh = shutil.which('zsh')
    if not zsh:
        sys.exit('zsh is required; no installation attempted')
    (ROOT / '.stage0').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='editing-', dir=ROOT / '.stage0') as directory:
        missing = probe(zsh, directory, None)
        fixed = probe(zsh, directory, 'xterm-256color')
    result = {'missingTerm': missing, 'xtermTerm': fixed,
              'reproducedVisualOnlyBug': not missing['displayCorrect'] and missing['commandResultCorrect']}
    print(json.dumps(result, indent=2))
    return 0 if all(fixed[k] for k in ('displayCorrect', 'cursorCorrect', 'commandResultCorrect')) else 1


if __name__ == '__main__':
    sys.exit(main())
