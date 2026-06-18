# Usage Guide

This guide walks through the normal Agent Black Box workflow from setup to report review.

## Requirements

- Node.js 20 or newer.
- pnpm.
- A Git repository.

Agent Black Box relies on Git status and diffs, so `abb start`, `abb stop`, and report commands must run inside a Git repository.

## Install From Source

```sh
pnpm install
pnpm build
```

During development, use:

```sh
pnpm dev -- <command>
```

After building, use:

```sh
node dist/cli.js <command>
```

## Initialize

```sh
abb init
```

This creates `.agentblackbox.json` with defaults for session output, ignored paths, risk patterns, and maximum file size for secret scanning.

The generated file includes a `configVersion` and `$schema` reference for editor validation.

Validate or migrate config:

```sh
abb config validate
abb config migrate
```

Legacy config files without `configVersion` still load in memory. Use `abb config migrate` when you want the file rewritten with the current schema.

## Start A Session

```sh
abb start
```

`abb start` runs as a foreground watcher. Leave it open while your editor, scripts, or coding agent changes files.

## Record Commands

Command recording is opt-in:

```sh
abb run -- pnpm test
abb run -- git status --short
abb run --cwd packages/app --label unit-tests -- pnpm test
```

Only metadata is recorded:

- Redacted command line.
- Working directory.
- Optional label.
- Start and end time.
- Duration.
- Exit code.

Terminal output is not captured.

Commands are executed without a shell. Pass the executable and arguments directly after `--`.

Sensitive-looking assignments and flags are redacted before writing reports:

```text
API_TOKEN=<redacted>
--password <redacted>
--client-secret=<redacted>
```

## Stop A Session

From another terminal:

```sh
abb stop
```

The foreground watcher receives a stop request, flushes pending file events, captures Git state, writes reports, and clears active session state.

If the watcher process is stale, `abb stop` finalizes from the current Git state.

## Review Reports

```sh
abb report
abb summary
abb commands
abb timeline
abb risks
abb risks --min-severity high
abb risks --category "CI/CD file" --json
abb rollback
abb export --output abb-session.md
abb export --format json --output abb-session.json
```

Reports are stored under:

```text
.agent-black-box/sessions/<session-id>/
```

## Recommended Workflow

1. Start from a clean or understood Git state.
2. Run `abb start`.
3. Let your AI coding agent or editor make changes.
4. Run important commands through `abb run -- <command>`.
5. Run `abb stop`.
6. Read `timeline.md`, `risks.md`, and `rollback.md`.
7. Review `git diff` before committing.

## Doctor

Use `doctor` when setup or session state looks wrong:

```sh
abb doctor
```

It checks Node.js, Git repository detection, config, write access, session directory, active/stale session state, and session lock state.

## Safe Rollback Apply

Rollback is advisory by default. To restore eligible tracked modified/deleted files, use explicit interactive mode:

```sh
abb rollback --apply --file src/example.ts
```

Agent Black Box prints a plan and requires typed confirmation before running `git restore`. Added or untracked files are never removed automatically.

## Export

Use `export` when you want a single artifact for review, issue attachments, or archival:

```sh
abb export --output abb-session.md
abb export --format json --output abb-session.json
```

Existing files are not overwritten unless `--force` is supplied.

Markdown exports bundle the summary, commands, timeline, diff summary, risks, and rollback hints. JSON exports preserve the full `session.json` structure.

## Common Problems

### Not inside a Git repository

Run Agent Black Box from a Git repository root or subdirectory.

### Session is stale

If the watcher was killed, run:

```sh
abb stop
```

Agent Black Box will finalize from current Git state when possible.

### No command history appears

Only commands run through `abb run -- <command>` are recorded. Shell history is not inspected.
