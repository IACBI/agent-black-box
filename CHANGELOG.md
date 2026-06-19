# Changelog

## 0.6.0

- Made the tag-driven release workflow idempotent when a GitHub Release already exists for the tag.
- Updated release documentation to avoid manual release creation before tag pushes.
- Added a persisted Git start baseline with HEAD, branch, index fingerprint, and pre-existing changed paths.
- Added change evidence that separates pre-existing paths, watcher observations, final-state changes, and transient observations.
- Added start-to-end HEAD tree comparison so committed changes remain visible when the final worktree is clean.
- Limited risk and possible-secret analysis to session-relevant final changes when a start baseline is available.
- Prevented interactive rollback from restoring files that already had changes at session start.
- Added baseline and attribution details to JSON, summary, timeline, diff, risk, and rollback reports.
- Added multilingual README parity coverage for all 12 in-page language sections.

## 0.5.3

- Hardened Markdown report rendering for repository-controlled paths, command metadata, risk text, and integrity warnings.
- Hardened shell command previews in rollback reports by using single-quoted path arguments and neutralizing line breaks.
- Added regression coverage for Markdown table escaping and shell-sensitive rollback path previews.

## 0.5.2

- Replaced short localized README blurbs with full in-page documentation sections for 11 non-English languages.
- Removed unnecessary explanatory text from the README language selector.
- Updated supporting docs to point to the full localized README documentation.

## 0.5.1

- Added a multilingual README language index with in-page anchors.
- Added local documentation references from usage, reports, and demo docs back to the README language section.
- Merged Dependabot's GitHub Actions maintenance update for `actions/checkout`.

## 0.5.0

- Added shared binary/text file inspection for Git snapshots and possible secret scanning.
- Improved untracked file diff metadata with file kind, size, line-stat source, and skipped-line notes.
- Added command grouping and phase metadata through `abb run --group` and `abb run --phase`.
- Updated command, timeline, summary, and diff reports to show group, phase, file kind, size, and stat-source details.
- Added coverage for binary detection, large-file classification, grouped command reporting, and updated CLI E2E behavior.

## 0.4.0

- Added versioned config support with JSON Schema, validation, and migration commands.
- Added atomic session locks, stale lock recovery, and corrupted event record recovery.
- Added deterministic risk scores and risk summary metadata to session reports.
- Added filtered `abb risks` output with severity, category, and JSON modes.
- Added `abb export` for bundled Markdown or structured JSON session exports.
- Updated tests and documentation for config migration, session recovery, risk filtering, and exports.

## 0.3.0

- Added CLI end-to-end coverage for real `init/start/run/stop/report` workflows.
- Added `abb doctor` for local environment, config, repository, and session diagnostics.
- Added `summary.md` and `abb summary` for concise review-first session output.
- Added `commands.md` and `abb commands` for command metadata review.
- Added safe interactive rollback apply mode for eligible tracked files.
- Extended `abb run` with `--cwd` and `--label`.
- Added release preparation docs and a release validation script.

## 0.2.0

- Added `abb run -- <command>` for opt-in command metadata recording during active sessions.
- Added redaction for sensitive command-line assignments and flags.
- Added estimated added-line counts for small untracked text files.
- Added CodeQL and tag-based release workflows.
- Reworked documentation for a clearer user journey and maintainer workflow.

## 0.1.0

- Initial Agent Black Box MVP.
- Added local-first CLI commands for session recording, status, reports, timeline, risks, and rollback hints.
- Added Git snapshot collection, file watching, risk detection, possible secret detection, Markdown reports, and JSON session output.
