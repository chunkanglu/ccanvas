# Native terminal editing — 2026-09-24

## TL;DR

A **missing `TERM` reproduces visually incorrect backspace editing while the
shell's actual command remains correct**. Native PTYs inherited the GUI launch
environment without declaring terminal capabilities. They now explicitly set
`TERM=xterm-256color` and `COLORTERM=truecolor`, matching the hosted renderer.
The patch is built and installed locally. **Kang confirmed it works perfectly
in the app and Pi loads (2026-09-24).**

## Report and isolation

Kang observed spacing errors in an unspaced lowercase alphabet at 100% zoom, a
missing styled prompt arrow, and backspaces appearing as spaces. It also happens
in upstream ccanvas. Repeated prompt lines in the screenshot were intentional,
not a bug. Bare `zsh -f` in the affected app still has spacing problems, with its
plain prompt remaining visible. Actual command editing is correct despite the
visual result.

The initial append-only PTY/xterm parser tests passed with or without TERM.
**That did not rule out TERM:** those tests omitted backspaces. Once deletion was
included, the missing-capability failure reproduced.

## Verification

`npm run probe:terminal` runs a clean zsh in a real POSIX PTY, feeds its output to
the project's installed xterm parser, and compares two environments. It types a
synthetic `print -r --` command plus the alphabet, deletes three characters, types
`XYZ`, then submits the harmless builtin to independently verify shell state.

| Environment | Display/cursor correct | Actual command result correct |
| --- | --- | --- |
| TERM absent — deliberate negative control | No; deletion paints spaces and moves the display cursor incorrectly | Yes |
| TERM=xterm-256color | Yes | Yes |

An isolated native WKWebView probe also rendered the synthetic and captured zsh
streams with the project's xterm/CSS and 100% canvas transforms. Its DOM text and
cell layout agreed with the buffer: malformed redraw bytes remain malformed on
screen; the corrected stream renders correctly. Local probe/snapshot evidence is
in ignored `.stage0/`. This was not inspection of the user's running canvas.

Additional checks passed:

- Rust regression covers absent, `dumb` and unrelated inherited TERM values while
  preserving unrelated environment entries; no process-global env mutation in tests.
- Rust fmt, offline/locked unit test and clippy.
- Eight stage-0 tests and ten installer tests.
- Real `npm run app:install`: unsigned debug rebuild, replacement of
  `~/Applications/ccanvas Pi.app`, Launch Services registration and index request.

## Scope of the patch

`src-tauri/src/pty.rs` configures terminal capabilities after inheriting the parent
process environment. Spotlight/Finder need not provide TERM, and a parent
terminal's TERM can also describe the wrong emulator. The browser PTY already
selects `xterm-256color` through node-pty's `name` option.

No font/zoom workaround, custom shell configuration change, Pi-specific behavior,
permission change or dependency installation. The probe requires existing Python
3, Node and zsh and does not read user shell config or invoke a model. The test
reports the negative control failing **by design**, not an installed-app failure.

## What is NOT done

No claim that all PTY replay/ordering or Pi parity issues are fixed. The original
native GUI symptom is user-confirmed resolved. Existing shells still retain their
spawn environment; the fix applies to newly spawned terminals. No commit/push or
published release.
