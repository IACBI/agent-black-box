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
12. Compact session metadata is written last so history listing can avoid parsing every full report.
13. The session catalog resolves `latest`, exact IDs, and unique ID prefixes without converting user input directly into filesystem paths.
14. `abb export` can bundle a selected session into Markdown or JSON.
15. `abb analyze` performs bounded, watcherless analysis of current included working-tree changes and can emit text, JSON, or SARIF findings.
16. `abb analyze --staged --baseline <ref>` compares staged blobs with a fixed commit, following Git-identified renames where safe and suppressing unchanged secret-like lines without exposing their contents.

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
- `session-replay.json` for reports larger than 32 MiB
- `session-search.json` when the bounded search index fits in 4 MiB
- `timeline.md`
- `summary.md`
- `commands.md`
- `diff-summary.md`
- `risks.md`
- `rollback.md`
- `session-metadata.json`

Malformed NDJSON event or command lines are skipped during finalization. Discarded counts and warnings are recorded in `session.json` and `summary.md`.

Catalog listing reads compact metadata in bounded batches. Sessions from older versions fall back to validated `session.json` data. Incomplete and corrupt session directories remain visible in `abb sessions list` but cannot be selected for reporting or comparison.

History filters first use catalog metadata, then a bounded search index for file paths, redacted commands, and risk categories. Missing or invalid indices fall back to the validated report. Retention defaults to a preview; interactive apply rechecks eligible completed reports and rejects active state, linked entries, and changed catalog plans before moving each directory to a hidden quarantine name for deletion.

Large reports keep the full `session.json` contract. A versioned replay sidecar stores a compact report body and content digests; structural commands reconstruct events and commands from the original NDJSON logs. Ready-made Markdown and JSON report files are streamed to stdout after verification. Legacy large reports can still be opened with a bounded direct parse.

## Safety Boundaries

- No external API is required at runtime.
- No telemetry is included.
- Terminal output is not captured.
- Possible secret values are redacted.
- Rollback remains advisory.
- Interactive rollback apply only restores eligible tracked files after typed confirmation.
- Files already changed at session start are never eligible for interactive rollback apply.
- Direct AI-agent private APIs are not used.
- Config and session state are validated before use with bounded string, date, process, and record constraints.
- Config, state, metadata, and inline session-report JSON reads have explicit size limits. Large reports use a bounded replay sidecar and a 256 MiB total report policy; over-budget finalization fails explicitly while raw logs remain available.
- Session output paths must remain physically inside the repository by default. A command-scoped override is required for trusted local external storage, while UNC and network paths remain blocked.
- Repository file inspection does not follow symbolic links, and command working directories cannot escape through links.
- JSON state and finalized reports use same-directory temporary files followed by atomic rename.
- Active state and lock files share a random owner token; recovery fails closed when their repository, session directory, or ownership does not match.
- Existing export files are not overwritten unless requested.

## Performance Notes

- File watching ignores common heavy directories such as `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, and `.agent-black-box`.
- Secret scanning skips deleted files, binary-like files, and files larger than the configured `maxFileSizeKb`.
- Shared file inspection classifies text, binary, large, missing, and non-regular files before estimating untracked line counts or scanning for possible secrets.
- Added-line estimation for untracked files only reads small text files and records when line stats were skipped.
- File and command events are appended as NDJSON to avoid rewriting large session state while recording.
- NDJSON finalization is streamed line by line, rejects lines larger than 1 MiB, caps accepted records at 1,000,000, and bounds integrity warnings.
- Git file inspection and possible-secret scanning use deterministic concurrency capped at eight workers and available CPU parallelism.
- Session locking uses an atomic lock file and random owner token. `abb recover` or `abb doctor --repair` handles only safely verified stale sessions; ambiguous state is not removed automatically.
- Staged Git metadata and blob identifiers relative to `HEAD` are represented by a SHA-256 fingerprint; report generation does not store staged file contents.
