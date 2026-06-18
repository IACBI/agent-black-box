# Report Reference

Agent Black Box generates Markdown reports for humans and `session.json` for tools.

## `session.json`

Structured session output containing:

- Session ID, repository root, session path, start time, end time, and finalization reason.
- File events observed by the watcher.
- Commands explicitly run through `abb run`.
- Git branch, status, diff summary, and changed files.
- Risk findings.
- Risk score, maximum severity, severity counts, and possible-secret count.
- Possible secret findings with redacted values.
- Integrity metadata for malformed event or command records skipped during recovery.

## `summary.md`

Short review-first summary:

- Session metadata.
- Changed file count.
- Recorded command count.
- Possible secret count.
- Risk severity counts.
- Risk score.
- Review priority.
- Notable changed files.
- Top risk signals.
- Report integrity status.

Use this report when you need the fastest overview.

## `commands.md`

Command metadata explicitly recorded through `abb run`:

- Redacted command line.
- Optional label.
- Repository-relative working directory.
- Exit code.
- Timestamp.

Terminal output is not captured.

## `timeline.md`

Chronological view of observable activity:

- Session metadata.
- Wrapped command metadata.
- File add/change/delete events.
- Combined chronological timeline.
- Files added, modified, deleted, renamed, or otherwise detected by Git.

Use this report first when you want to understand the shape of a session.

## `diff-summary.md`

Git-focused summary:

- Current Git status.
- Tracked Git diff summary.
- Changed file table with line counts where available.
- Estimated added-line counts for small untracked text files.
- Notable risk categories.

Line counts for untracked files are best-effort estimates. Large files and binary-like files are skipped.

## `risks.md`

Review signals based on path patterns and changed files:

- Environment files.
- Dependency and lock files.
- CI/CD files.
- Docker files.
- Migrations.
- Auth and security paths.
- Config files.
- Possible secret-like values.

Findings are not proof of a vulnerability. They are prompts for human review.

Each risk includes a deterministic score from 0 to 100. Scores are derived from severity, change size, and file status. Possible secret findings raise the overall session risk score but still require human validation.

Filter latest risk output:

```sh
abb risks --min-severity high
abb risks --category "CI/CD file"
abb risks --json --min-severity medium
```

## Exports

`abb export` creates a single review artifact from the latest session:

- Markdown export bundles `summary.md`, `commands.md`, `timeline.md`, `diff-summary.md`, `risks.md`, and `rollback.md`.
- JSON export emits the structured `session.json`.
- Risk filters can be applied to Markdown exports.
- Existing output files are not overwritten unless `--force` is provided.

## `rollback.md`

Manual rollback guidance:

- Current Git status.
- `git status --short`.
- `git diff`.
- File-level `git diff -- <file>` suggestions.
- `git restore -- <file>` and `git checkout -- <file>` suggestions for modified tracked files.
- Optional interactive apply mode for eligible tracked modified/deleted files.

Agent Black Box never automatically reverts changes.

## Redaction

Reports redact possible secret values. Command metadata also redacts sensitive-looking arguments before writing them to disk.

The tool is heuristic. It can miss real secrets and can produce false positives. Treat reports as review aids, not security proof.
