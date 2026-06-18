# Changelog

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
