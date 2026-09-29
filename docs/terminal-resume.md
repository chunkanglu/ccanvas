# Terminals resume after restart

Pi agents resume their conversation through their session file. Plain terminals now resume what matters about them, the same way: their history and directory.

## What resumes

When you quit and reopen ccanvas Pi (desktop), each terminal on an autosaved canvas gets:

- **Its history:** the last 1 MiB of output, with colors. A dim `── restored from previous session ──` line marks where live output starts again.
- **Its directory:** the new shell starts wherever the old one last was. If that folder no longer exists, it starts in the terminal's original folder.
- **Its commands:** your shell's own history (↑, Ctrl-R) is unchanged, because the shell manages it.

**Not resumed:** running programs. A dev server or `npm run watch` stops when the app quits, and after a restart you get a fresh shell. Keeping processes alive across quits would need a detachable backend such as tmux; see "Options not taken".

## When snapshots are written

- On quit.
- Every 30 s for terminals with new output, so a crash or force-quit loses at most about 30 s.
- Terminals on tabs you haven't opened since the restart keep their earlier snapshot until you open them.

## Privacy and cleanup

Terminal output can contain secrets, so snapshots are kept out of `.ccnvs` documents:

- **Location:** they live in `~/Library/Application Support/io.github.chunkanglu.ccanvas-pi/terminal-snapshots/`.
- **Permissions:** the folder is private (0700) and each file is readable only by you (0600).
- **File names:** hex-encoded runtime IDs, so names cannot contain path separators.

Snapshots are deleted when you:

- delete the terminal;
- close its tab;
- leave it unused for 30 days.

Opening a `.ccnvs` file as a new tab does not pick up another tab's snapshots.

## Safety of the replay

Old output can contain terminal *queries*, for example "report the cursor position". Replaying one into a fresh terminal would type a stale answer such as `^[[?1;2c` into the new shell. These are stripped before replay:

- device attributes;
- cursor, status, and window reports;
- mode and version requests;
- color queries;
- DCS strings.

A soft reset then leaves any full-screen, mouse, or bracketed-paste mode the old session ended in.

## Scope

- Desktop only. The optional web backend (`npm run server`) doesn't save snapshots.
- Agent terminals (legacy Claude) are excluded, because their harness already resumes them.
- The directory is read natively: `lsof` on macOS, `/proc` on Linux. It needs no shell configuration. Windows has no directory lookup yet, so the history still restores there but the directory doesn't.

## Options not taken

- **tmux or dtach behind every terminal:** would keep programs running across quits. But it adds a dependency, changes how every terminal starts, and leaves shells running after you quit. It's worth doing only if keeping processes alive is the goal.
- **Saving output into the `.ccnvs` file:** documents are portable and may be shared or committed, and terminal output isn't safe to share.
