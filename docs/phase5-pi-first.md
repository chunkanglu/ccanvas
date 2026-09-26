# Phase 5 — Pi-first defaults, usage, and knowledge

## Status

Implemented and accepted on `fork/phase5-pi-first`.

Installed-app acceptance passed Pi-first creation paths, Claude legacy preservation and explicit creation, Claude-to-Pi configuration handoff, recent launch profiles, usage/context scope, knowledge-graph sources, and normal Pi workflow regression. Acceptance found two defects, both fixed and retested: git-worktree creation no longer depends on WKWebView's unsupported `window.prompt`, and the graph empty state no longer covers source controls.

Automated evidence: Stage 0 10, Phase 1 3, Phase 2 17, Phase 3 3, Phase 4 9, Phase 5 9, installer 10, Rust 13, TypeScript/Vite build, Rust fmt/clippy, actual no-model companion probe including stats, and diff checks.

Known upstream limitation outside this phase: template naming, checkpoint labels, and Git-panel repo/branch prompts still use `window.prompt`/`confirm` and may not work in the macOS app.

## Decisions

### New agents default to Pi; existing agents keep their identity

Every new-agent path opens the wizard with **Pi** selected: toolbar, command palette, quick insert, welcome action, and git-worktree creation. Claude remains available as an explicit legacy harness.

Existing `.ccnvs` agents, v1 migrations, autosaves, and templates without a `harness` remain Claude. Changing a default never rewrites saved documents or relabels Claude history as Pi history.

Claude agents gain **Create Pi agent from this configuration**. It copies nonsecret launch context — title, color, cwd/worktree, and initial prompt as an editable Pi draft — but never migrates a transcript or translates Claude permission bypasses into Pi trust or approval.

### Pi launch profiles and missing executables

Hard-coded Claude model aliases are removed from Pi creation shortcuts. Successfully created Pi agents record a small recent list of nonsecret launch profiles: provider, model, and thinking level. No credentials, trust choices, or environment values are stored.

The wizard checks the configured launcher without executing it. If Pi is unavailable it shows setup guidance. ccanvas never installs Pi and never silently launches Claude instead.

### Usage scope

Pi usage comes from the companion. It mirrors Pi 0.84's `getSessionStats()` accounting over session entries: assistant usage, tool-result usage, and branch/compaction summary usage. Current context occupancy uses Pi's `getContextUsage()` and remains unknown when Pi reports unknown, such as directly after compaction.

The usage pill labels the aggregate as **attached Pi sessions**. Multiple widgets showing the same session are counted once. Costs are Pi's model-price estimates, not bills or account quotas. There is no Pi five-hour reset.

The existing Claude five-hour estimate remains a separate **Claude Code (legacy)** section.

### Knowledge graph sources

The graph renderer remains. Its source is explicit:

- Existing graph widgets without a source keep the legacy Claude project-memory source.
- New graph widgets use a user-selected Markdown folder, such as a chosen Obsidian subfolder.

Markdown loading is read-only and bounded: at most 400 notes, four directory levels, and 256 KiB per note. Dot-directories and dependency/build directories are skipped. Wikilinks resolve by relative path, frontmatter aliases, then unique basename; ambiguous basenames are not guessed. ccanvas does not scan an entire vault by default or invent a Pi memory directory.

### Surrounding workflow

Yaks remain execution tracking and Obsidian remains substantive knowledge. Native Pi TUI extensions, intercom, tool profiles, and sub-agent tools remain Pi-owned. ccanvas flows do not replace agent-to-agent tools. No agent-controlled canvas CLI is added in this phase.

## Acceptance gate

Automated tests cover default creation, legacy compatibility, profiles, launcher status, protocol validation, usage accounting/deduplication, and Markdown graph parsing/resolution/bounds.

Installed-app checks cover every creation path, missing-launcher guidance, Claude legacy/handoff, usage scope and unknown context, Markdown/legacy graph sources, and normal Pi extensions/intercom/yaks.

## What is not done

- No transcript conversion between harnesses.
- No account-wide Pi quota or billing claim.
- No automatic whole-vault graph scan.
- No agent-controlled ccanvas CLI.
- No web managed-Pi controls before origin/auth hardening.
