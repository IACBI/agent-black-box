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
abb doctor --json
```

`init` creates configuration without replacing an existing file, including concurrent creation. Exclusive atomic publication requires filesystem hard-link support and fails visibly when unavailable. Legacy configuration without `configVersion` loads in memory; `config migrate` rewrites it with the current schema.

`abb doctor --json` prints one structured report with `ok`, `repoRoot`, and `checks` (each has `name`, `status`, and `message`). It exits 1 if any check fails; warnings alone retain exit 0. Invalid configuration prevents session-storage inspection. After a successful `abb doctor --repair --json`, stdout contains only the final doctor report. JSON escapes terminal controls while preserving the values restored by `JSON.parse`.

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
| `secretPatterns`                   | Optional extra secret patterns; see [Custom secret rules](#custom-secret-rules)  |
| `secretAllowlist`                  | Optional documented exceptions; see [Custom secret rules](#custom-secret-rules)  |

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

### Custom secret rules

Both detectors (recorded sessions and `analyze`) and command redaction read two optional keys:

```json
{
  "secretPatterns": [
    { "name": "Internal service token", "pattern": "corp_[a-z0-9]{16}" },
    { "name": "Legacy token", "pattern": "legacy-[a-z]{6}", "ignoreCase": true }
  ],
  "secretAllowlist": [
    { "path": "tests/fixtures", "reason": "synthetic credentials used by the test suite" },
    { "contains": "AKIAIOSFODNN7EXAMPLE", "reason": "the documented AWS example key" },
    { "path": "docs", "contains": "sk-example-only", "reason": "placeholder in the guide" }
  ]
}
```

**Patterns** are JavaScript regular expressions matched against one line at a time (only the first 4,096 characters of a line). A match is reported as `Possible <name> detected.` without the matched text, and the same expression redacts matches from recorded commands, labels, groups, and phases. Up to 32 patterns of at most 256 characters are accepted. A pattern is refused when it is not a valid expression, matches the empty string, uses a backreference, or nests a quantifier inside a quantified group such as `(a+)+`. That last check is a best-effort screen against catastrophic backtracking, not a proof, so keep patterns simple and anchored by a literal prefix. File scanning batches up to 64 independent line prefixes and 65,536 total UTF-16 code units per worker message, compiling patterns once per message. The existing 500 ms execution deadline applies to the entire bounded batch; memory/output limits remain unchanged. Exhaustion fails scanning explicitly and redacts the whole input. Lines longer than 4,096 code units produce visible partial-scan diagnostics even when no match is found or findings are allowlisted. Built-in detectors still inspect the full retained line, and finalized sessions record custom-pattern limits in integrity warnings.

**Allowlist** entries hide findings with a recorded reason. An entry needs `path`, `contains`, or both, and always a `reason`. `path` uses the same case-insensitive path and segment matching as `exclude`; `contains` is literal text the line must include (8 to 256 characters, so a short value cannot allow far too much). When both are present, both must match. Never put a real secret in `contains`: the file is normally committed. Up to 256 entries are accepted.

Hidden findings are not silent. `analyze` JSON and SARIF carry `secretAllowlist.suppressedFindings` (the text output prints it), and a recorded session shows "Possible secrets hidden by the configured allowlist" in `summary.md` and `risks.md` and `riskSummary.allowlistedSecretCount` in `session.json`. The allowlist only affects possible-secret findings; metadata risks such as a changed `.env` file are unchanged, and baseline comparison applies the same rules to both sides.

An invalid rule is a configuration error: `abb config validate` reports it and commands that load the configuration stop, rather than scanning without the rule.

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

The starting Git baseline is limited to 32 MiB of serialized UTF-8 JSON. An oversized baseline prevents session creation before ownership state is published; stored baselines exceeding this limit are reported as unavailable evidence.

`run` accepts `--cwd`, `--label`, `--group`, and `--phase`. Pass executable arguments after `--`; native executables run without a shell. The working directory must remain physically inside the repository, including through symlinks/junctions. Standard input/output are inherited, not stored. The child exit code is propagated; startup failure returns 1 and is recorded. Durations use a monotonic clock; timestamps use system time.

On Windows, `.cmd`/`.bat` scripts run through a `cmd.exe` wrapper. Batch arguments containing percent signs, line breaks, or NUL are rejected. Bare command names, native or script, resolve through absolute PATH entries in PATHEXT order (`.COM`, `.EXE`, `.BAT`, `.CMD` as ordered there). Executables and scripts in the current or repository directory are never picked up implicitly, and an unresolved name is recorded as `ENOENT`; pass an explicit path such as `abb run -- .\scripts\task.bat` for repository files. Compound shell syntax is not interpreted for native executables.

Command metadata is redacted before writing. Supported forms include sensitive assignments/flags (including `passphrase`, `pwd`, and `credential` names), headers, JSON arguments with sensitive keys, URL credentials in any scheme such as `postgres://user:password@host` (only the password is hidden for non-HTTP schemes, so `ssh://git@host` stays readable), and sensitive query parameters. Arguments that are scripts (`sh -c "export TOKEN=..."`) are scanned for assignments, headers, and `--password value` flags. Short credential flags are recognised per tool: `curl -u/--user`, `mysql`/`mysqldump`/`mysqladmin`/`mariadb -pSECRET`, `redis-cli -a`, `sshpass -p`, and `docker`/`podman login -p`. Provider token shapes (AWS, GitHub, Slack, Stripe, Google, LLM API keys, JWTs) are hidden wherever they appear, and your own `secretPatterns` apply too. Labels, groups, and phases receive the same best-effort redaction. Arbitrary command syntax is not guaranteed secret-free.

When custom patterns are configured, their matches and built-in credential/script matches are evaluated against original argument text and their overlapping ranges are masked together. A partial custom match cannot prevent a built-in rule from masking the rest of a recognized credential. When URL, JSON, assignment, or tool-flag rewriting could invalidate a custom match, the whole argument is hidden. Safe formatting is preserved when custom patterns do not match; executed arguments remain unchanged.

`stop` verifies active state and lock ownership, requests finalization, and waits for the watcher. In-flight recorded commands delay finalization. After roughly ten seconds the CLI can report that finalization is pending; the watcher continues. Use `status` to check progress.

`abb status --capture-health` inspects durable watcher-loss and command-completion markers without loading event logs or changing the session. `abb status --json` includes the same diagnostics and omits private ownership tokens. `doctor` also reports capture health for an inspectable active/recoverable session. Status remains informational; degraded health is a diagnostic, not a failed status command.

Health is scoped to persisted markers: `healthy` means a complete inspection found no persisted loss/interruption evidence, `degraded` means such evidence exists, and `unknown` means the inspection cannot establish health. Check `inspectionComplete` and `truncated` in JSON; partial degraded counts are lower bounds. The scan stops after 10,000 directory entries. Live process IDs can be reused, and watcher buffers, pending writes, and unrecorded losses are not observable. Preserve degraded session evidence and inspect the final report's capture warnings.

For a dead watcher, use `abb recover` or `abb doctor --repair`. Repair requires verified stale ownership or valid completed reports backing the state. Corrupt/inconsistent state remains available for diagnosis; do not delete evidence merely to silence an error.

Recovery can optionally bound how long it waits for live recorded commands and how many event/command records and bytes it retains:

```sh
abb recover --command-wait-timeout-ms 10000 --max-record-bytes 67108864 --max-records 100000 --max-rss-mb 512
```

`--command-wait-timeout-ms` accepts a positive safe integer in milliseconds; omitted, the existing wait remains unlimited. A timeout stops recovery without deleting live command markers, changing active/lock ownership, or publishing a partial report. Finish the wrappers, inspect capture health, and retry. This bounds the live-command wait, not the total recovery duration or operating-system scheduling.

`--max-record-bytes` accepts an integer from 1 to 268435456 (256 MiB), shared across both logs. The default is 256 MiB, consistent with the existing report limit; a smaller value is optional. It counts the UTF-8 canonical JSON of accepted records, including unknown fields, before retention. Malformed lines keep their existing diagnostics and do not consume this allowance. Parsed objects, array/stream buffers, Git data, and report metadata are outside the quota, so it is not a heap/RSS cap. Exceeding it preserves logs and ownership; retry with a sufficient budget after inspecting the evidence. Report formatting/core overhead can still trigger the existing 256 MiB final-report guard. Linked or displaced session directories are refused before finalization writes.

If storage is displaced during finalization, the location is rechecked before publication and the uncertain claim is retained. Restore the original trusted storage and let the failed finalizer exit before retrying; do not remove another process's claim to force recovery. Ordinary quota and command-wait refusals still release their own claim while retaining active ownership, so they support the documented retry.

If a completed session stopped between active-state and lock cleanup, these commands can resume cleanup using its saved ownership receipt and verified report. A missing receipt, linked storage, mismatched ownership, damaged evidence, or a live owner prevents automatic cleanup. Existing completed evidence is not rewritten. Finalization flushes existing event/command logs before publishing completion metadata. On POSIX, publication and cleanup also synchronize directory entries in ownership order; failures stop the operation and preserve retryable proof. Windows retains file-content synchronization and process-interruption recovery, with no portable Node directory-entry flush. These barriers improve durability without guaranteeing every filesystem/device's power-loss behavior.

`--max-records` accepts a positive safe integer and limits the combined accepted record count across event and command logs before array retention. It complements the byte quota when many small records would create many objects. Malformed lines do not consume the count. The exact count is allowed; exceeding it refuses the entire finalization, preserves evidence/ownership, and permits retry with a sufficient count. Omitted, existing per-log reader limits remain unchanged. Programmatic callers can set `FinalizeSessionOptions.maxRecords` on recovery or finalization. This bounds retained record count, not object size, parsing allocations, or RSS.

`--max-rss-mb` accepts a positive integer in MiB whose byte conversion is a safe integer. It refuses recovery when observed whole-process resident memory exceeds that threshold. Library callers use `FinalizeSessionOptions.maxRssBytes`. A process already over the threshold is refused before claiming/mutating session ownership. During finalization, checks run during live-wrapper polling and at input-chunk, record-retention, and phase boundaries, including before publication. Started readers still settle before claims are released; an ordinary refusal preserves logs and active/lock ownership and supports a sufficient-threshold retry. Existing byte/count quotas remain independent. Omitted, no RSS threshold is imposed.

This is an observed-memory stop condition, not a hard RSS cap: synchronous parsing/serialization, native allocations, workers, and other activity may overshoot between checkpoints. Worker RSS contributes to the Node process total; separate Git/other child processes have their own RSS. For hard containment use OS-enforced isolation/resource limits appropriate to your platform. A V8 heap flag or worker `resourceLimits` does not bound total RSS. An OS kill cannot run cleanup; preserve the evidence and inspect stale ownership before retrying.

Capture reads refuse linked/non-regular logs, pin a descriptor, and compare exact device/inode/size/timestamps before and after parsing against the current pathname. A growing log can consume at most its opened length plus one byte before refusal. Accepted worktree text reads also use exact identities and a final pathname check. These checks detect verified replacement/growth cases; they are not an atomic defense against an uncooperative process with the same filesystem permissions.

For resource-constrained recovery, start with byte/count quotas and an observed RSS threshold, inspect a refusal, and increase only what the evidence requires. Keep a backup before retention/rollback work. Use trusted local repository/storage directories; avoid concurrent moves and link changes. For untrusted repositories, use an isolated OS account/container and process memory limits appropriate to that environment; never treat CLI quotas or cooperative hook locks as a process sandbox.

Before sharing a report, inspect it locally, use synthetic reproductions in public issues, and keep independently trusted verification keys outside the repository. Keep GitHub secret scanning and push protection enabled as additional layers; they and ABB's heuristics cannot guarantee detection of encoded, split, or unknown credentials. Run staged `complete-review` when incomplete scan coverage must block a change.

## Analyze without recording

```sh
abb analyze
abb analyze --format json
abb analyze --format sarif --fail-on high
abb analyze --staged --baseline HEAD --policy complete-review --format sarif
```

| Option                      | Behavior                                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--format <format>`         | `text` (default), `json`, or `sarif`                                                                                                      |
| `--staged`                  | Read index blobs instead of working-tree content                                                                                          |
| `--baseline <ref>`          | With `--staged`, compare against a resolved Git commit                                                                                    |
| `--initial`                 | With `--staged` and no HEAD commit, treat all staged content as new; excludes `--baseline`                                                |
| `--fail-on <severity>`      | Exit 1 for a finding at or above `low`, `medium`, or `high`                                                                               |
| `--policy <profile>`        | Built-in or configured named policy; requires `--staged` with `--baseline` or `--initial`                                                 |
| `--max-total-bytes <bytes>` | Optional non-negative safe integer limiting retained UTF-8 analysis content across current and baseline files; `0` skips nonempty content |

Baseline comparison suppresses identical existing secret-like lines up to their baseline occurrence count. Git-verified renames can use the previous path as the baseline. Metadata risks remain visible; excluded baseline paths and unverified rename relationships do not suppress content findings.

Text findings show a verified rename's baseline source path; SARIF findings carry it in `result.properties.baselineSourcePath`, while their primary location remains the staged destination. JSON retains the existing `baselineComparison.renameSources` contract.

For a repository's first commit, use `abb analyze --staged --initial --policy complete-review`. `--initial` requires an unborn HEAD, treats every staged finding as new, and applies staged coverage gates without manufacturing a baseline. JSON includes `initialCommitAnalysis: true`; SARIF includes it in run properties. Repositories with a HEAD commit must use `--baseline`.

`new-secrets` fails on newly detected possible secrets. `complete-review` also fails when non-deleted staged content or needed baseline content could not be fully scanned, including the custom-pattern line limit. Combining `--fail-on` and a policy fails when either condition applies. Operational errors return 1; findings alone do not fail the command without a threshold/policy.

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

Profiles default to `failOnNewSecrets: true` and `requireCompleteCoverage: false`. Setting `failOnNewSecrets: false` explicitly disables the secret gate for that profile. `minSeverity` optionally gates metadata-risk findings; `categories` narrows only that gate using exact, case-insensitive category names and requires `minSeverity`. Secret and coverage gates remain independent. Filtering a gate does not remove findings from the report. JSON/SARIF include `severityRiskCount` for custom profiles. If any content is only partially scanned, policy results also include `limitedStagedFiles` and `limitedBaselineFiles`; these fields are absent when coverage has no such limits.

At most 32 profiles are allowed; names match `[a-z][a-z0-9-]{0,63}`. Built-in names cannot be overridden, unknown fields/names fail validation, and category lists contain 1–32 non-empty strings of at most 128 characters. Policies never run automatically; choose one explicitly. The same staged/index and baseline-or-initial requirements apply to every profile.

### Git pre-commit hook

`abb hook install` writes a managed `pre-commit` hook that blocks a commit when staged content fails a policy:

```sh
abb hook install                   # policy new-secrets
abb hook install --policy ci-review # a named policy from analysisPolicies
abb hook install --policy ci-review --first-commit policy
abb --allow-external-session-dir hook install # authorize trusted local external storage for this hook
abb hook status
abb hook uninstall
```

ABB hook mutations reserve `.pre-commit.abb-lock` in the effective physical hooks directory with exclusive creation. A concurrent install/update/forced replacement/uninstall refuses visibly and can be retried after the owner finishes. The lock contains the owner's PID and creation time; cleanup verifies exact file identity and physical directory before unlinking its own lock. A replaced lock is left untouched. Read-only status does not acquire it, and uninstall does not create an absent hooks directory.

A crash may leave a stale lock. No automatic takeover or force-lock bypass is provided. Stop concurrent hook maintenance, verify the recorded process has exited and the physical directory/lock still belong to this operation, then inspect/remove only that stale lock before retrying. Never remove a live, uncertain, or replacement lock merely to silence an error. This coordination covers ABB participants; external tools can still race filesystem mutations.

The hook runs `abb analyze --staged --baseline HEAD --policy <policy>`. The first commit of a repository has no baseline commit, so it runs `abb analyze --staged --fail-on high` instead. Custom patterns and the allowlist from `.agentblackbox.json` apply, so a documented exception lets a commit through.

`--first-commit high` is the default and preserves that fallback. Choose `--first-commit policy` to run `abb analyze --staged --initial --policy <policy>` for the first commit as well. A configured policy can explicitly disable its secret gate, so choose its gates deliberately. Both opt-ins are shown by `hook status`; reinstalling without them returns to the default script.

- **Fail-open.** If `abb` is not on PATH (a GUI Git client, a fresh clone, another Node setup) the hook prints a notice and lets the commit proceed. Treat CI as the enforcement point and the hook as a convenience.
- **Foreign hooks are protected.** The hook is recognised by a marker line. `install` refuses to replace a `pre-commit` file that it did not write; `--force` backs it up to `pre-commit.pre-abb` first (and refuses if that backup already exists). `uninstall` removes only a managed hook and restores `pre-commit.pre-abb` when it exists; any other hook is left alone and the command exits 1.
- **Reinstalling is safe.** An identical hook reports "already up to date"; a different policy updates it. `status` reports `absent`, `managed`, `managed-outdated` (re-run `install`), or `foreign`. On POSIX, missing execute permission also marks a managed hook as outdated, and reinstalling repairs it.
- **Where it writes.** `core.hooksPath` and linked worktrees are honoured. The hooks directory must be inside the repository (or its Git directory): a shared global `core.hooksPath` is refused, because installing there would change every repository that uses it. A symbolic-link `pre-commit` is never written through.
- **Configuration and policy are checked before installation.** Policy names match `[a-z][a-z0-9-]{0,63}` and must select a built-in or configured profile. Invalid configuration or an unknown policy leaves existing hooks and backups unchanged. External session storage is refused unless installation explicitly uses the global `--allow-external-session-dir` option. The generated hook then retains that fixed flag for future runs; network and UNC storage remain blocked. Only authorize storage configured by a repository you trust.

The generated script is POSIX `sh`; Git for Windows runs hooks with its bundled shell, so it works on Windows too.

Worktree, staged, and baseline CLI reads are capped at the smaller of `maxFileSizeKb` and 256 KiB. Deleted, binary, oversized, unsafe, or unavailable content is reported as skipped. Text summarizes coverage; JSON and SARIF retain structured coverage, policy, and rename-comparison details. When custom patterns encounter longer lines, `coverage.limited` lists the file, fixed reason, and number of truncated lines; `baselineComparison.limited` identifies any partial needed baseline scans. These diagnostics are absent when no custom patterns are configured or all relevant lines fit the limit. Findings contain locations and fixed descriptions, not matched values.

Use `abb analyze --staged --baseline HEAD --policy complete-review --max-total-bytes 16777216` to limit retained content to 16 MiB across staged and needed baseline text. Admissions follow input order; binary, missing, and oversized files do not consume the retained-content quota. A refused file remains visible in coverage with a budget reason, so `complete-review` fails when required content cannot fit. Git blob sizes are checked before content requests, avoiding oversized blob-body reads. The option budgets encoded UTF-8 content, including replacement-character expansion; transient per-file buffers, parsed objects, decoded strings, and runtime overhead are additional memory. It is not a heap/RSS cap. Defaults remain unchanged without the option.

Recorded-session detection and `analyze` use different heuristics. For example, recording can flag an environment-variable password assignment that analysis excludes, while analysis retains different assignment-value exclusions and token-length thresholds. Provider and structured credential signals are shared. Both recognise private-key headers, and both apply your `secretPatterns` and `secretAllowlist`. Neither is a comprehensive security scanner.

## Read and export reports

All commands below accept `--session <id>`: full ID, unique prefix, or `latest` (default).

| Command          | Result / additional options                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `abb report`     | Full stored session JSON                                                                                                         |
| `abb summary`    | Review summary                                                                                                                   |
| `abb commands`   | Recorded command metadata                                                                                                        |
| `abb timeline`   | File events and commands                                                                                                         |
| `abb risks`      | Risk report; `--min-severity low\|medium\|high`, `--category <category>`, `--json`                                               |
| `abb rollback`   | Advisory restore plan; interactive options below                                                                                 |
| `abb export`     | Bundled Markdown (default), full JSON, or SARIF via `--format markdown\|json\|sarif`; `--output <path>`, `--force`, risk filters |
| `abb pr-comment` | Compact Markdown for a pull request comment; `--output <path>`, `--force`                                                        |

Risk category filtering matches an exact category case-insensitively. Severity/category filters narrow risk findings, not overall summaries or the separate possible-secret list. Export risk filters apply to the Markdown risk section and to the risk results of a SARIF export, never to possible secrets; JSON remains a full report.

```sh
abb risks --session latest --min-severity high --json
abb export --session latest --output review.md
abb export --format json --output review.json
```

### Pull request comments and SARIF export

`abb pr-comment` prints a compact, GitHub-flavoured Markdown summary of one session: a verdict line, the highest-severity risks, possible-secret locations (never values), recorded commands with exit codes, and any capture-loss or integrity warnings, so a reviewer sees when the recording was incomplete. It starts with the marker `<!-- agent-black-box:session-summary -->` so tooling can find and update its own comment, and it is capped below GitHub's 65,536-character limit (cut at a line boundary with a visible notice). Repository text is escaped, bidirectional and zero-width characters are made visible, and `@` mentions are defused. Nothing is sent anywhere; posting is your command:

```sh
abb pr-comment | gh pr comment --body-file -
abb pr-comment --output comment.md
```

`abb export --format sarif` writes a SARIF 2.1.0 log of one session for code-scanning tools: risks become `session-risk:<category>` results, possible secrets become `possible-secret` results at their line, results carry a stable fingerprint, and run properties include the session ID, the risk summary, and capture warnings. Matched values never appear.

Exports write to stdout unless `--output` is supplied. New output files are published only after their complete contents are written, using an exclusive hard link; the destination filesystem must support and permit hard links. Unsupported publication fails visibly without falling back to a partial copy. Concurrent exporters cannot replace each other’s output. Existing destinations require `--force`, which atomically replaces the destination file; a destination leaf symlink is replaced rather than writing through to its target. If the target does not support hard links, choose another destination, use stdout, or explicitly choose `--force` only when replacing any existing destination is intended. `--force` uses same-directory atomic rename and does not require hard links; it still requires filesystem rename support and permission. On POSIX, directory-sync errors can be reported after a complete file was published: inspect the destination before retrying, and do not assume it is absent. File formats, evidence fields, integrity verification, and storage limits are defined in [Reports](REPORTS.md).

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

`show` and `compare` accept full IDs, unique prefixes, or `latest`; both support `--json`. Comparison summarizes path, risk, command-frequency, possible-secret location/count, and HEAD differences. Its additive `secrets` section identifies changes by path, line, and reason; it never includes credential values or redacted excerpts. Commands with null exit codes count as unsuccessful. Content history filters use a bounded metadata search index, with validated-report fallback for older sessions.

`list`, `browse`, `show` and `compare` accept optional `--memory-budget-mb <8–4096>`. History uses one read worker, reserves the verification stream buffers described below, and allocates half the remaining budget to encoded JSON inputs and their buffered copies. Budgeted content searches read one index or fallback report at a time; full replay-backed reads share the input quota between stored JSON and replay metadata, validate the exact parsed bytes and records, and stream log digests.

```sh
abb sessions list --file src/auth --memory-budget-mb 64 --json
abb sessions show latest --memory-budget-mb 64 --json
abb sessions compare <from> <to> --memory-budget-mb 128 --json
```

A quota refusal fails visibly and leaves evidence intact. Plain listings may show a complete session with metadata unavailable and a warning; they never substitute zero counts or a guessed `latest` marker. Metadata-dependent filters and limits refuse ambiguous results. Browser selections that exceed the quota display the refusal and let you continue or quit; corruption still fails. Increase the budget to inspect that report. These are encoded-input limits, not a heap/RSS cap: parsed reports retained for comparison, catalog/results, decoded strings and V8 overhead remain outside the quota. Defaults are unchanged without the option.

To check that stored sessions are intact without changing them, use `abb sessions verify [session]`. It validates each completed report with the same checks used before pruning, notes missing derived Markdown reports, skips incomplete sessions, and exits 1 if any report fails. `--json` prints the structured result.

```sh
abb sessions verify
abb sessions verify latest --json
abb sessions verify --memory-budget-mb 64 --concurrency 2 --json
abb sessions verify latest --check-indexes --json
abb sessions verify latest --repair-indexes --json
```

`--check-indexes` compares derived `session-metadata.json` and `session-search.json` against verified canonical evidence without writing. `--repair-indexes` implies checking and explicitly regenerates inconsistent or missing indexes; it preserves canonical report/log bytes, rejects linked targets and active session state, and publishes metadata last. Repairs run with one worker and use that same input quota for session selection and inspection. JSON includes `indexIssues`, `repairedIndexes`, `skippedIndexes`, or `indexError` when applicable. A search index omitted because its derived content exceeds the format limit is expected, not missing evidence. Explicit index checks/repairs exit 1 on inspection refusal, unresolved inconsistency, or repair failure. A memory-budget refusal leaves evidence intact; increase the quota rather than forcing a repair. Verification without these options keeps its existing behavior.

Full replay verification streams canonical event digests instead of materializing event arrays. Optional `--memory-budget-mb` accepts 8–4096 MiB and allocates a working-data quota across workers. `--concurrency` accepts 1–16 (default 4); a budget reduces it to at most one worker per 8 MiB. Per worker, stream buffers reserve approximately 4.375 MiB; half the remaining quota limits each materialized JSON input, allowing for its buffered copy. Oversized inputs fail visibly before parsing. Increase the budget or lower concurrency when an intact legacy/inline report cannot fit; no records are silently discarded to satisfy the quota.

Large-report reads also stream-validate canonical JSON and bind every compact replay-core field and record digest to that canonical report before using it. Streaming quotas charge replay JSON plus retained canonical core and one active canonical record; event/command arrays are validated without retention. No stored report migration is required.

This is an encoded-input and stream-buffer budget, not a hard JavaScript heap/RSS limit: decoded strings, parsed objects, catalog entries and returned results require additional memory. Existing file/line/count limits still apply, and defaults remain unchanged when no budget is selected. Budgeted legacy catalog fallback streams replay digests; if a report's metadata cannot be obtained within the quota, choose an explicit session ID or increase the budget. `latest` refuses an ambiguous selection rather than guessing.

```sh
abb sessions archive --before 2026-01-01 --keep 2 --to .agent-black-box/archive
abb sessions archive --before 2026-01-01 --keep 2 --to .agent-black-box/archive --resume
abb sessions archive --before 2026-01-01 --keep 2 --to .agent-black-box/archive --resume --apply
abb sessions prune --before 2026-01-01 --keep 2
```

These commands preview completed sessions started before the UTC cutoff (exclusive). Use `--before` or configure `retention.days`; `--keep` defaults to `retention.keep` or 1. Both require `--apply`, an interactive terminal, and typed confirmation to execute. Incomplete/corrupt sessions are excluded and active state, links, and the preview are rechecked before mutation.

Archive requires `--to` or `retention.archiveDir`, outside the session root. A destination read from the configuration must stay physically inside the repository (links included), because a cloned repository could otherwise point `--apply` anywhere you can write; pass `--to` to choose an external destination yourself. It verifies copied files with checksums and writes `.abb-archive-complete.json` only after verification. Originals remain in place. By default an existing destination session ID is refused. `--resume` previews each destination as missing, resumable, complete, or conflicting without modifying it; `--resume --apply` keeps typed confirmation and copies only missing files. Every existing file must match the source; divergent bytes, extra entries, linked/special paths, or invalid completion metadata refuse continuation. Complete matching archives are preserved. Prune validates full replay-record integrity before deletion. An interrupted prune can leave `.pruning-*` under the session root; inspect such remnants before removing them.

## Troubleshooting

| Symptom                               | Action                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| No repository / invalid configuration | Run inside a Git repository; use `abb config validate` and `abb doctor`                           |
| Stale session                         | Use `abb recover` or `abb doctor --repair`; preserve inconsistent state                           |
| No command history                    | Record commands explicitly through `abb run`; shell history is not read                           |
| Skipped analysis content              | Read coverage reasons; use `complete-review` when a partial CI review must fail                   |
| Refused rollback                      | Review changes since finalization and the eligible-file list; restore manually if appropriate     |
| Windows command not found             | Put its `.cmd`/`.bat` directory on PATH, or pass an explicit repository-relative or absolute path |

## Evidence signing and credential limits

Use `abb sessions sign <id> --private-key <encrypted-pem>` with the passphrase in `ABB_SIGNING_PASSPHRASE` (or select an environment variable with `--passphrase-env <name>`). See [Evidence security](EVIDENCE-SECURITY.md) for optional `abb sessions sign`, signature-required `abb sessions verify --trusted-key`, key provisioning requirements, redaction resource bounds, and the precise trust guarantees and remaining limitations.
