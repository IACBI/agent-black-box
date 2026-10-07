# Usage

See the [English/Türkçe overview](../README.md), [report reference](REPORTS.md), and [architecture](ARCHITECTURE.md).

## Setup and configuration

Requires Node.js 22 or newer, Git on PATH, and pnpm 10.30.3 as pinned in `package.json`. From a source checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Examples use `abb`; substitute `pnpm dev` or `node dist/cli.js`. Use `abb --help` or `abb <command> --help` for help and `abb --version` for the version. Recording, analysis, history, and report commands require a Git repository; initialization and config validation/migration can run outside one.

```sh
abb init # Only when .agentblackbox.json does not exist
abb config validate
abb config migrate
abb doctor
```

`init` creates configuration without replacing an existing file, including concurrent creation. Exclusive atomic publication requires filesystem hard-link support and fails visibly when unavailable. Legacy configuration without `configVersion` loads in memory; `config migrate` rewrites it with the current schema.

| Setting                            | Default and contract                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `configVersion`, `$schema`         | Version `1` and an editor-validation schema reference                            |
| `sessionDir`                       | `.agent-black-box/sessions`; physically inside the repository by default         |
| `exclude`                          | `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, `.agent-black-box` |
| `riskPatterns`                     | Built-in sensitive paths                                                         |
| `maxFileSizeKb`                    | `500`; integer from 1 to 102400, measured in 1024-byte units                     |
| `retention.days`, `retention.keep` | Optional integers from 1 to 100000                                               |
| `retention.archiveDir`             | Optional trusted local archive destination                                       |
| `analysisPolicies`                 | Optional named staged CI policies; selected explicitly with `analyze --policy`   |

Non-empty custom `exclude` and `riskPatterns` arrays replace defaults; empty arrays fall back to defaults. See [default risk patterns](https://github.com/IACBI/agent-black-box/blob/main/src/config/defaults.ts). Matching is case-insensitive and uses path components/segments, not glob expressions. If you move storage to another repository directory, add its parent to `exclude` to avoid recording its output.

Optional retention defaults do not trigger automatic copying or deletion:

```json
{ "retention": { "days": 30, "keep": 2, "archiveDir": ".agent-black-box/archive" } }
```

To intentionally use trusted local session storage outside the repository, pass the global `--allow-external-session-dir` option on every relevant command:

```sh
abb --allow-external-session-dir start
```

The override is not saved in configuration. UNC/network storage is rejected.

## Record and finalize

Start the foreground watcher and leave it running while editing:

```sh
abb start
```

In another terminal:

```sh
abb run -- pnpm test
abb run --cwd packages/app --label unit-tests --group validation --phase test -- pnpm test
abb status
abb stop
abb summary
abb risks
```

A session stores the starting Git baseline, so an understood dirty worktree is supported and existing changes are marked as pre-existing. Session IDs are opaque; obtain them from history rather than constructing timestamp-based IDs.

`run` accepts `--cwd`, `--label`, `--group`, and `--phase`. Pass executable arguments after `--`; native executables run without a shell. The working directory must remain physically inside the repository, including through symlinks/junctions. Standard input/output are inherited, not stored. The child exit code is propagated; startup failure returns 1 and is recorded. Durations use a monotonic clock; timestamps use system time.

On Windows, `.cmd`/`.bat` scripts run through a `cmd.exe` wrapper. Batch arguments containing percent signs, line breaks, or NUL are rejected. Bare command names, native or script, resolve through absolute PATH entries in PATHEXT order (`.COM`, `.EXE`, `.BAT`, `.CMD` as ordered there). Executables and scripts in the current or repository directory are never picked up implicitly, and an unresolved name is recorded as `ENOENT`; pass an explicit path such as `abb run -- .\scripts\task.bat` for repository files. Compound shell syntax is not interpreted for native executables.

Command metadata is redacted before writing. Supported forms include sensitive assignments/flags, headers, JSON arguments with sensitive keys, URL credentials, and sensitive query parameters. Labels, groups, and phases receive the same best-effort redaction. Arbitrary command syntax is not guaranteed secret-free.

`stop` verifies active state and lock ownership, requests finalization, and waits for the watcher. In-flight recorded commands delay finalization. After roughly ten seconds the CLI can report that finalization is pending; the watcher continues. Use `status` to check progress.

`abb status --capture-health` inspects durable watcher-loss and command-completion markers without loading event logs or changing the session. `abb status --json` includes the same diagnostics and omits private ownership tokens. `doctor` also reports capture health for an inspectable active/recoverable session. Status remains informational; degraded health is a diagnostic, not a failed status command.

Health is scoped to persisted markers: `healthy` means a complete inspection found no persisted loss/interruption evidence, `degraded` means such evidence exists, and `unknown` means the inspection cannot establish health. Check `inspectionComplete` and `truncated` in JSON; partial degraded counts are lower bounds. The scan stops after 10,000 directory entries. Live process IDs can be reused, and watcher buffers, pending writes, and unrecorded losses are not observable. Preserve degraded session evidence and inspect the final report's capture warnings.

For a dead watcher, use `abb recover` or `abb doctor --repair`. Repair requires verified stale ownership or valid completed reports backing the state. Corrupt/inconsistent state remains available for diagnosis; do not delete evidence merely to silence an error.

## Analyze without recording

```sh
abb analyze
abb analyze --format json
abb analyze --format sarif --fail-on high
abb analyze --staged --baseline HEAD --policy complete-review --format sarif
```

| Option                 | Behavior                                                            |
| ---------------------- | ------------------------------------------------------------------- |
| `--format <format>`    | `text` (default), `json`, or `sarif`                                |
| `--staged`             | Read index blobs instead of working-tree content                    |
| `--baseline <ref>`     | With `--staged`, compare against a resolved Git commit              |
| `--fail-on <severity>` | Exit 1 for a finding at or above `low`, `medium`, or `high`         |
| `--policy <profile>`   | Built-in or configured named policy; requires `--staged --baseline` |

Baseline comparison suppresses identical existing secret-like lines up to their baseline occurrence count. Git-verified renames can use the previous path as the baseline. Metadata risks remain visible; excluded baseline paths and unverified rename relationships do not suppress content findings.

`new-secrets` fails on newly detected possible secrets. `complete-review` also fails when non-deleted staged content or needed baseline content could not be scanned. Combining `--fail-on` and a policy fails when either condition applies. Operational errors return 1; findings alone do not fail the command without a threshold/policy.

Add named profiles to `.agentblackbox.json` to choose different gates for local commits and CI:

```json
{
  "analysisPolicies": {
    "local-review": { "failOnNewSecrets": true },
    "ci-review": {
      "requireCompleteCoverage": true,
      "minSeverity": "medium",
      "categories": ["CI/CD file", "Auth/security-related file"]
    }
  }
}
```

```sh
abb analyze --staged --baseline HEAD --policy local-review
abb analyze --staged --baseline HEAD --policy ci-review --format sarif
```

Profiles default to `failOnNewSecrets: true` and `requireCompleteCoverage: false`. Setting `failOnNewSecrets: false` explicitly disables the secret gate for that profile. `minSeverity` optionally gates metadata-risk findings; `categories` narrows only that gate using exact, case-insensitive category names and requires `minSeverity`. Secret and coverage gates remain independent. Filtering a gate does not remove findings from the report. JSON/SARIF include `severityRiskCount` for custom profiles; built-in result shapes and behavior remain unchanged.

At most 32 profiles are allowed; names match `[a-z][a-z0-9-]{0,63}`. Built-in names cannot be overridden, unknown fields/names fail validation, and category lists contain 1–32 non-empty strings of at most 128 characters. Policies never run automatically; choose one explicitly. The same staged/index and baseline requirements apply to every profile.

To block risky commits locally, call the same policy from `.git/hooks/pre-commit` (make it executable and keep `abb` on PATH). The first commit has no baseline commit, so it uses a severity threshold instead:

```sh
#!/bin/sh
if git rev-parse --verify --quiet HEAD >/dev/null; then
  exec abb analyze --staged --baseline HEAD --policy new-secrets
fi
exec abb analyze --staged --fail-on high
```

Worktree, staged, and baseline CLI reads are capped at the smaller of `maxFileSizeKb` and 256 KiB. Deleted, binary, oversized, unsafe, or unavailable content is reported as skipped. Text summarizes coverage; JSON and SARIF retain structured coverage, policy, and rename-comparison details. Findings contain locations and fixed descriptions, not matched values.

Recorded-session detection and `analyze` use different heuristics. For example, recording can flag an environment-variable password assignment that analysis excludes, while analysis recognizes some token/private-key forms absent from the recording detector. Neither is a comprehensive security scanner.

## Read and export reports

All commands below accept `--session <id>`: full ID, unique prefix, or `latest` (default).

| Command        | Result / additional options                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `abb report`   | Full stored session JSON                                                                                          |
| `abb summary`  | Review summary                                                                                                    |
| `abb commands` | Recorded command metadata                                                                                         |
| `abb timeline` | File events and commands                                                                                          |
| `abb risks`    | Risk report; `--min-severity low\|medium\|high`, `--category <category>`, `--json`                                |
| `abb rollback` | Advisory restore plan; interactive options below                                                                  |
| `abb export`   | Bundled Markdown (default) or full JSON via `--format markdown\|json`; `--output <path>`, `--force`, risk filters |

Risk category filtering matches an exact category case-insensitively. Severity/category filters narrow risk findings, not overall summaries or the separate possible-secret list. Export filters apply only to the Markdown risk section; JSON remains a full report.

```sh
abb risks --session latest --min-severity high --json
abb export --session latest --output review.md
abb export --format json --output review.json
```

Exports write to stdout unless `--output` is supplied. Existing destinations require `--force`, which atomically replaces the destination file; a destination leaf symlink is replaced rather than writing through to its target. File formats, evidence fields, integrity verification, and storage limits are defined in [Reports](REPORTS.md).

### Rollback

```sh
abb rollback --apply --file src/example.ts
```

Without `--apply`, rollback only prints guidance. Apply requires an interactive terminal, a preview, and typed confirmation. `--file <path...>` narrows the plan; only eligible tracked modified/deleted files from the latest completed session can be restored. Added/untracked files are not deleted, and paths changed before recording are excluded.

Before restore, HEAD, index fingerprint, selected path status, contents, and location must still match the private session-end snapshot. Missing or changed evidence refuses apply. Restore uses `HEAD`, not a backup of the pre-session worktree. Manual report snippets use POSIX shell quoting; on Windows use CLI apply for eligible files or adapt commands deliberately.

## History and retention

```sh
abb sessions list --state complete --since 2026-01-01 --min-severity medium --limit 20
abb sessions browse --file src/auth --command test --category security --page-size 10
abb sessions show <id> --json
abb sessions compare <from> <to> --json
```

`list` and `browse` support `--state complete|incomplete|corrupt`, `--since YYYY-MM-DD` (UTC, inclusive), `--min-severity`, `--file <text>`, `--command <text>`, and `--category <text>`. Text filters are case-insensitive substring matches. `list` also supports `--json` and positive-integer `--limit`. `browse` requires an interactive terminal; `--page-size` defaults to 10 and accepts 1–50. Select a number, `n`/`p` for pages, or `q` to quit. Incomplete/corrupt entries remain visible but cannot be opened.

`show` and `compare` accept full IDs, unique prefixes, or `latest`; both support `--json`. Comparison summarizes path, risk, command-frequency, and HEAD differences. Content history filters use a bounded metadata search index, with validated-report fallback for older sessions.

To check that stored sessions are intact without changing them, use `abb sessions verify [session]`. It validates each completed report with the same checks used before pruning, notes missing derived Markdown reports, skips incomplete sessions, and exits 1 if any report fails. `--json` prints the structured result.

```sh
abb sessions verify
abb sessions verify latest --json
abb sessions verify --memory-budget-mb 64 --concurrency 2 --json
```

Full replay verification streams canonical event digests instead of materializing event arrays. Optional `--memory-budget-mb` accepts 8–4096 MiB and allocates a working-data quota across workers. `--concurrency` accepts 1–16 (default 4); a budget reduces it to at most one worker per 8 MiB. Per worker, stream buffers reserve approximately 4.375 MiB; half the remaining quota limits each materialized JSON input, allowing for its buffered copy. Oversized inputs fail visibly before parsing. Increase the budget or lower concurrency when an intact legacy/inline report cannot fit; no records are silently discarded to satisfy the quota.

This is an encoded-input and stream-buffer budget, not a hard JavaScript heap/RSS limit: decoded strings, parsed objects, catalog entries and returned results require additional memory. Existing file/line/count limits still apply, and defaults remain unchanged when no budget is selected. Budgeted legacy catalog fallback streams replay digests; if a report's metadata cannot be obtained within the quota, choose an explicit session ID or increase the budget. `latest` refuses an ambiguous selection rather than guessing.

```sh
abb sessions archive --before 2026-01-01 --keep 2 --to .agent-black-box/archive
abb sessions prune --before 2026-01-01 --keep 2
```

These commands preview completed sessions started before the UTC cutoff (exclusive). Use `--before` or configure `retention.days`; `--keep` defaults to `retention.keep` or 1. Both require `--apply`, an interactive terminal, and typed confirmation to execute. Incomplete/corrupt sessions are excluded and active state, links, and the preview are rechecked before mutation.

Archive requires `--to` or `retention.archiveDir`, outside the session root. It verifies copied files with checksums, never overwrites an existing session ID, and writes `.abb-archive-complete.json` only after verification. Originals remain in place. Prune validates full replay-record integrity before deletion. An interrupted prune can leave `.pruning-*` under the session root; an interrupted archive can lack its completion marker. Inspect these remnants before removing them.

## Troubleshooting

| Symptom                               | Action                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| No repository / invalid configuration | Run inside a Git repository; use `abb config validate` and `abb doctor`                           |
| Stale session                         | Use `abb recover` or `abb doctor --repair`; preserve inconsistent state                           |
| No command history                    | Record commands explicitly through `abb run`; shell history is not read                           |
| Skipped analysis content              | Read coverage reasons; use `complete-review` when a partial CI review must fail                   |
| Refused rollback                      | Review changes since finalization and the eligible-file list; restore manually if appropriate     |
| Windows command not found             | Put its `.cmd`/`.bat` directory on PATH, or pass an explicit repository-relative or absolute path |
