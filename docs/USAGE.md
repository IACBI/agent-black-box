# Usage Guide

This guide walks through the normal Agent Black Box workflow from setup to report review.

Full localized README documentation is available in the language section: [Languages](../README.md#languages).

## Requirements

- Node.js 22 or newer. Node.js 20 reached end of life and is no longer supported.
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
pnpm dev <command>
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

Before watcher observations begin, Agent Black Box stores a Git baseline. Starting from a clean or understood worktree gives the clearest attribution, but a dirty worktree is supported and its existing changes are marked as pre-existing.

## Record Commands

Command recording is opt-in:

```sh
abb run -- pnpm test
abb run -- git status --short
abb run --cwd packages/app --label unit-tests -- pnpm test
abb run --group validation --phase test -- pnpm test
```

Only metadata is recorded:

- Redacted command line.
- Working directory.
- Optional label.
- Optional group and phase.
- Start and end time.
- Duration.
- Exit code.

Terminal output is not captured.

Commands are executed without a shell. Pass the executable and arguments directly after `--`.

`--cwd` must resolve physically inside the repository. Paths that escape through a symbolic link or junction are rejected.

Use `--group` for related command batches such as `validation`, `release`, or `database`. Use `--phase` for workflow stages such as `setup`, `test`, `build`, or `deploy`.

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

If the watcher process is stale, recover it explicitly from the current Git state:

```sh
abb recover
```

Recovery only runs when active state and lock ownership agree. For a diagnosis and safe repair in one command, use `abb doctor --repair`.

## Analyze Current Changes Without A Watcher

Use `analyze` in CI or before a review when a recording session is unnecessary:

```sh
abb analyze
abb analyze --format json
abb analyze --format sarif --fail-on high
```

It inspects included working-tree changes with bounded local reads. Findings contain locations and fixed descriptions only; they never include matched secret values.

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

Select a specific completed session with a full ID, unique prefix, or `latest`:

```sh
abb summary --session session-2026-06-19
abb risks --session session-2026-06-19 --min-severity high
abb export --session session-2026-06-19 --output selected-session.md
```

Reports are stored under:

```text
.agent-black-box/sessions/<session-id>/
```

## Session History And Comparison

```sh
abb sessions list
abb sessions list --json
abb sessions show <session-id>
abb sessions show <session-id> --json
abb sessions compare <from-session> <to-session>
abb sessions compare <from-session> <to-session> --json
```

The catalog lists complete, incomplete, and corrupt sessions. Only completed sessions can be shown, compared, exported, or selected by report commands. `latest` resolves to the newest completed session, so an active incomplete session does not hide the latest usable report.

Interactive `abb rollback --apply` is restricted to the latest completed session. Historical rollback reports remain readable with `--session`, but they cannot be applied to the current worktree.

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
abb doctor --repair
```

It checks Node.js, Git repository detection, config, write access, session directory, and validated session ownership. `--repair` only finalizes a safely identified stale session or removes state already backed by completed reports.

## Safe Rollback Apply

Rollback is advisory by default. To restore eligible tracked modified/deleted files, use explicit interactive mode:

```sh
abb rollback --apply --file src/example.ts
```

Agent Black Box prints a plan and requires typed confirmation before running `git restore`. Added or untracked files are never removed automatically.

Files that already had changes at session start are not eligible for interactive restore. `git restore --source=HEAD` cannot preserve their pre-session state, so applying it would risk data loss.

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
abb recover
```

Agent Black Box finalizes from current Git state only when the state and lock owner match. Inconsistent or unreadable state is left untouched for manual review.

### No command history appears

Only commands run through `abb run -- <command>` are recorded. Shell history is not inspected.
