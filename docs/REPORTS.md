# Report Reference

Agent Black Box generates Markdown reports for humans and `session.json` for tools.

## `session.json`

Structured session output containing:

- Session ID, repository root, session path, start time, end time, and finalization reason.
- File events observed by the watcher.
- Commands explicitly run through `abb run`.
- Git branch, status, diff summary, and changed files.
- Risk findings.
- Possible secret findings with redacted values.

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

## `rollback.md`

Manual rollback guidance:

- Current Git status.
- `git status --short`.
- `git diff`.
- File-level `git diff -- <file>` suggestions.
- `git restore -- <file>` and `git checkout -- <file>` suggestions for modified tracked files.

Agent Black Box never automatically reverts changes.

## Redaction

Reports redact possible secret values. Command metadata also redacts sensitive-looking arguments before writing them to disk.

The tool is heuristic. It can miss real secrets and can produce false positives. Treat reports as review aids, not security proof.
