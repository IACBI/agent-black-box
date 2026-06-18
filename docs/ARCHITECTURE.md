# Architecture

Agent Black Box is a TypeScript CLI built around observable repository state.

## Main Modules

```text
src/
  cli.ts
  commands/
  config/
  git/
  reports/
  risks/
  session/
  utils/
  watcher/
```

## Data Flow

1. `abb init` writes `.agentblackbox.json`.
2. `abb start` creates a session directory and active session state.
3. The watcher records file events to append-only NDJSON.
4. `abb run -- <command>` records redacted command metadata to append-only NDJSON.
5. `abb stop` finalizes the active session.
6. Finalization collects Git status and diff data.
7. Risk and possible-secret detectors analyze changed files.
8. JSON and Markdown reports are written to the session directory.

## Session Files

During a session:

- `.agent-black-box/active-session.json`
- `.agent-black-box/stop-request.json`
- `.agent-black-box/sessions/<session-id>/events.ndjson`
- `.agent-black-box/sessions/<session-id>/commands.ndjson`

Final reports:

- `session.json`
- `timeline.md`
- `diff-summary.md`
- `risks.md`
- `rollback.md`

## Safety Boundaries

- No external API is required at runtime.
- No telemetry is included.
- Terminal output is not captured.
- Possible secret values are redacted.
- Rollback remains advisory.
- Direct AI-agent private APIs are not used.

## Performance Notes

- File watching ignores common heavy directories such as `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, and `.agent-black-box`.
- Secret scanning skips deleted files, binary-like files, and files larger than the configured `maxFileSizeKb`.
- Added-line estimation for untracked files only reads small text files.
- File and command events are appended as NDJSON to avoid rewriting large session state while recording.
