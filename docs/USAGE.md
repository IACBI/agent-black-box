# Usage Guide

This guide walks through the normal Agent Black Box workflow from setup to report review.

The README is available in [English](../README.md#english) and [Türkçe](../README.md#turkce).

## Requirements

- Node.js 22 or newer. Node.js 20 reached end of life and is no longer supported.
- pnpm 10.30.3, as pinned in `package.json`.
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

The examples below use `abb` as shorthand. For a source checkout without a globally installed executable, replace `abb` with `pnpm dev` or `node dist/cli.js`.

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

Optional retention defaults can be added without changing the config version:

```json
{ "retention": { "days": 30, "keep": 2, "archiveDir": ".agent-black-box/archive" } }
```

These values set the default UTC cutoff, minimum newest-session count, and local archive destination for `sessions prune` and `sessions archive`. No deletion or copying runs automatically.

## Session Output Location

`sessionDir` is resolved from the repository root and must remain inside that repository by default. This prevents repository-controlled configuration from silently sending session evidence to another local or network location. UNC and network paths are always rejected.

If you intentionally use a trusted local directory outside the repository, explicitly opt in for the command that needs it:

```sh
abb --allow-external-session-dir start
```

Use this only for a location you control. The override is not stored in `.agentblackbox.json`, so a cloned repository cannot silently reuse the permission.

## Start A Session

```sh
abb start
```

`abb start` runs as a foreground watcher. Leave it open while your editor, scripts, or coding agent changes files.

New session IDs combine a timestamp and a random suffix. Treat IDs as opaque values obtained from `abb sessions list`; full IDs and unique prefixes continue to work, including IDs created by earlier versions. Session creation never reuses an existing session directory.

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

Terminal output is not captured. Duration uses a monotonic clock, while start and end timestamps use system time; a clock adjustment can move timestamps backwards without losing the command record.

Pass the executable and arguments directly after `--`. Native executables run without a shell. On Windows, `.cmd` and `.bat` shims require a `cmd.exe` wrapper; arguments containing percent signs or line breaks are rejected because the command interpreter can expand or reinterpret them.

`--cwd` must resolve physically inside the repository. Paths that escape through a symbolic link or junction are rejected.

Use `--group` for related command batches such as `validation`, `release`, or `database`. Use `--phase` for workflow stages such as `setup`, `test`, `build`, or `deploy`.

Sensitive-looking assignments and flags are redacted before writing reports:

```text
API_TOKEN=<redacted>
--password <redacted>
--client-secret=<redacted>
--header=X-Api-Key:<redacted>
--data=<redacted>
```

Credential-bearing URL user information and sensitive URL query parameters are also redacted, including URLs passed as option values. JSON arguments with sensitive-looking keys are masked as a whole. Labels, groups, and phases receive the same best-effort treatment. Review reports before sharing them: arbitrary command syntax cannot be guaranteed secret-free.

## Stop A Session

From another terminal:

```sh
abb stop
```

`abb stop` validates the active repository, session directory, and lock owner before writing a stop request. Corrupt or inconsistent state produces an error and remains available for diagnosis. The foreground watcher receives a valid stop request, flushes pending file events, captures Git state, writes reports, and clears active session state.

If the watcher process is stale, recover it explicitly from the current Git state:

```sh
abb recover
```

Recovery only runs when active state and lock ownership agree. Completion metadata alone is insufficient to remove stale state: the completed report must also be valid. For a diagnosis and safe repair in one command, use `abb doctor --repair`.

## Analyze Current Changes Without A Watcher

Use `analyze` in CI or before a review when a recording session is unnecessary:

```sh
abb analyze
abb analyze --format json
abb analyze --format sarif --fail-on high
abb analyze --staged --format json
abb analyze --staged --baseline HEAD --format json
abb analyze --staged --baseline HEAD --policy new-secrets --format sarif
```

By default, it inspects included working-tree changes with bounded local reads. `--staged` inspects the Git index blobs instead, so unstaged edits cannot change the pre-commit result. Add `--baseline <ref>` to compare staged content against a fixed Git commit: identical existing secret-like lines are suppressed up to their baseline occurrence count, while metadata risks remain visible. When Git identifies a rename between that commit and the index, the old path supplies the baseline if the new path did not exist there. Excluded source paths and renames Git cannot establish remain visible as new content findings. Text output lists skipped paths and rename sources; JSON includes `coverage` and `baselineComparison.renameSources` with destination, source, and suppression count, and SARIF includes the corresponding run properties. Findings contain locations and fixed descriptions only; they never include matched secret values.

For CI, `--policy new-secrets` exits with code 1 only when staged content contains a possible secret not found at the selected baseline. `--policy complete-review` also fails when non-deleted staged content or needed baseline content could not be scanned. Both require `--staged --baseline`; the chosen profile and counts appear in text, JSON, and SARIF output. `--fail-on` remains available and, when combined with a policy, either rule can fail the command.

Assignment checks consider each supported assignment on a line, including values after a benign assignment, and retain one secret finding per line. SARIF output shares rule descriptors across matching findings and percent-encodes file URI components, preserving paths containing spaces, `#`, or `%`.

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
abb sessions list --state complete --since 2026-01-01 --min-severity medium
abb sessions list --file src/auth --command test --category security --limit 20
abb sessions browse --state complete --page-size 10
abb sessions show <session-id>
abb sessions show <session-id> --json
abb sessions compare <from-session> <to-session>
abb sessions compare <from-session> <to-session> --json
abb sessions prune --before 2026-01-01
abb sessions archive --before 2026-01-01 --to .agent-black-box/archive
```

The catalog lists complete, incomplete, and corrupt sessions. Only completed sessions can be shown, compared, exported, or selected by report commands. `latest` resolves to the newest completed session, so an active incomplete session does not hide the latest usable report.

History filters are case-insensitive substring matches for session-relevant file paths, recorded redacted commands, and risk categories. Date filtering uses UTC. Content filters use a bounded search index for new sessions and fall back to the validated report for older sessions. A filtered result is marked `latest` only when it is also the newest completed session overall.

`sessions browse` supports the state, date, severity, file, command, and category filters in an interactive terminal. Enter a number to read a completed session summary, `n` or `p` to change pages, and `q` to quit. Incomplete and corrupt sessions remain visible but cannot be opened. Page size is limited to 1–50 to keep terminal output bounded.

`sessions prune` previews completed sessions started before the given UTC date and keeps at least the newest completed session (or `--keep <count>`). Incomplete and corrupt directories are never selected. To delete the previewed sessions, run the same command with `--apply` in an interactive terminal and type the requested confirmation. The command rechecks the catalog, report validity, active state, and directory links before deletion. If deletion is interrupted, a hidden `.pruning-*` directory may remain under the session root; inspect it manually before removing it.

`sessions archive` uses the same selection policy, previews the destination, and copies eligible sessions only after `--apply` and typed confirmation. It streams file checksums to verify each copy and writes `.abb-archive-complete.json` after verification. Original sessions remain in place; use the separate `prune` preview if you later choose to delete them. An interrupted copy leaves an archive directory without the completion marker for manual inspection. Archives contain the same potentially sensitive reports as the originals, so choose a trusted local destination. The archive cannot be inside the session root, and an existing session ID at the destination is never overwritten.

Interactive `abb rollback --apply` is restricted to the latest completed session. Historical rollback reports remain readable with `--session`, but they cannot be applied to the current worktree. Apply also checks that HEAD, the Git index, eligible path status, and eligible file contents still match the session's private rollback snapshot. If the snapshot is missing or anything differs, apply stops without restoring files.

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
