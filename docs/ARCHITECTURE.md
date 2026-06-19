# Architecture

Agent Black Box is a TypeScript CLI built around observable repository state.

Full localized README documentation is available in the language section: [Languages](../README.md#languages).

## Main Modules

```text
src/
  cli.ts
  commands/
  config/
  export/
  git/
  reports/
  risks/
  session/
  utils/
  watcher/
```

## Data Flow

1. `abb init` writes a versioned `.agentblackbox.json`.
2. `abb config validate/migrate` validates or rewrites config against the current schema.
3. `abb start` creates a session directory, active session state, and a process lock, then captures a Git start baseline.
4. The baseline records HEAD, branch, an index fingerprint, and changed paths that existed before watcher observations begin.
5. The watcher records file events to append-only NDJSON.
6. `abb run -- <command>` records redacted command metadata to append-only NDJSON.
7. `abb stop` finalizes the active session.
8. Finalization collects Git status, worktree diffs, and net file changes between the start and end HEAD, filtered by configured excludes.
9. Start state, watcher observations, Git metadata, and final state are combined into cautious change evidence.
10. Risk and possible-secret detectors analyze session-relevant final changes.
11. JSON and Markdown reports are written to the session directory.
12. `abb export` can bundle the latest session into Markdown or JSON.

## Session Files

During a session:

- `.agent-black-box/active-session.json`
- `.agent-black-box/session.lock`
- `.agent-black-box/stop-request.json`
- `.agent-black-box/sessions/<session-id>/events.ndjson`
- `.agent-black-box/sessions/<session-id>/commands.ndjson`
- `.agent-black-box/sessions/<session-id>/git-start.json`

Final reports:

- `session.json`
- `timeline.md`
- `summary.md`
- `commands.md`
- `diff-summary.md`
- `risks.md`
- `rollback.md`

Malformed NDJSON event or command lines are skipped during finalization. Discarded counts and warnings are recorded in `session.json` and `summary.md`.

## Safety Boundaries

- No external API is required at runtime.
- No telemetry is included.
- Terminal output is not captured.
- Possible secret values are redacted.
- Rollback remains advisory.
- Interactive rollback apply only restores eligible tracked files after typed confirmation.
- Files already changed at session start are never eligible for interactive rollback apply.
- Direct AI-agent private APIs are not used.
- Config and session state are validated before use.
- Existing export files are not overwritten unless requested.

## Performance Notes

- File watching ignores common heavy directories such as `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, and `.agent-black-box`.
- Secret scanning skips deleted files, binary-like files, and files larger than the configured `maxFileSizeKb`.
- Shared file inspection classifies text, binary, large, missing, and non-regular files before estimating untracked line counts or scanning for possible secrets.
- Added-line estimation for untracked files only reads small text files and records when line stats were skipped.
- File and command events are appended as NDJSON to avoid rewriting large session state while recording.
- Session locking uses an atomic lock file and recovers stale locks left by crashed processes.
- Staged Git metadata and blob identifiers relative to `HEAD` are represented by a SHA-256 fingerprint; report generation does not store staged file contents.
