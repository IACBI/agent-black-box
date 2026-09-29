# Report reference

Reports default to `.agent-black-box/sessions/<session-id>/`. `session.json` is the structured contract; Markdown presents observable evidence for review. See [Usage](USAGE.md) for commands.

## Files and fields

| File                                   | Contents and role                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `session.json`                         | Identity/times/finalization, capture, Git/evidence, risks and integrity.           |
| `session-start.json`, `git-start.json` | Initial identity; capture time, HEAD/branch/index and pre-existing changes.        |
| `events.ndjson`                        | Append-only timestamp, relative path and add/change/unlink event.                  |
| `commands.ndjson`, `commands.md`       | Redacted command/cwd, label/group/phase, exit status, timestamps and duration.     |
| `session-metadata.json`                | Versioned times, counts, severity/score, secret count, branch/HEADs; written last. |
| `session-search.json`                  | Derived relevant paths, redacted commands and risk categories.                     |
| `session-replay.json`                  | Compact report body, sizes, counts and digests for reconstruction.                 |
| `rollback-state.json`                  | Private end-state HEAD/index and file identities for restore preflight.            |
| `summary.md`                           | Counts, score/priority, notable changes, attribution and integrity warnings.       |
| `timeline.md`                          | File/command chronology, final changes and net HEAD changes.                       |
| `diff-summary.md`                      | Git status/stat text, paths, kinds/sizes, line counts and skipped-stat notes.      |
| `risks.md`                             | Path categories, severity/score/reason and redacted possible-secret locations.     |
| `rollback.md`                          | Manual Git inspection/restore guidance and eligible-file apply instructions.       |

## Evidence and interpretation

Evidence separates pre-existing paths, observations, final changes and Git metadata changes. Net HEAD changes retain committed work with a clean worktree. Risk analysis excludes unchanged pre-existing paths when attribution permits; missing baselines or changed index state conservatively include final changes.

Tracked counts describe unstaged changes; staged-only changes may lack counts despite staged stat text. Small untracked text uses estimates; binary/large/missing/non-regular paths record skipped statistics.

Scores are deterministic 0–100 review signals, not vulnerability proof. Supported command patterns and detected values are redacted; false positives/missed secrets remain possible. Recorded/watcherless heuristics differ. Review shared artifacts.

Terminal output is not captured. Durations are monotonic; wall-clock timestamps can reorder after clock changes. Integrity preserves discarded-record counts, overflow, write failures and recovery warnings even when exact losses are unknown.

## Selection and exports

Report/export selection uses `--session <id>`: `latest`, a full ID or unique prefix. New and legacy IDs work; incomplete/corrupt sessions cannot be selected. History uses metadata/search indices with validated-report fallback. Comparison covers relevant files, risks, commands and HEADs.

`abb risks` and Markdown exports accept `--min-severity`/`--category`; these narrow risk findings only. JSON exports preserve the full report; Markdown bundles the six review reports. Ordinary exports use exclusive creation. `--force` atomically replaces the destination after writing succeeds; a destination link is replaced without changing its target.

CLI rollback apply requires the latest completed session, eligible tracked modified/deleted files and typed confirmation. Restore targets HEAD; pre-existing changes are excluded. Snapshots are checked before confirmation and immediately before restore; missing/mismatched snapshots disable apply. Manual snippets use POSIX syntax. See [Security](../SECURITY.md) for library boundaries.

## Limits and verification

Inline JSON reads stop at 32 MiB. Larger reports retain full JSON and reconstruct from bounded replay/original logs. Above 256 MiB or a 32 MiB replay body, finalization fails and raw logs remain. Legacy large reports use bounded direct parsing with higher memory. Search indices above 4 MiB are omitted.

Structural reads/pruning validate reconstructed record counts/digests and discarded-line counts. Large-report streaming, completed-state recovery and archive preflight check the report digest/log sizes without replaying records. Streamed files must be regular and match their opened identity. Catalog metadata is not a full integrity scan.

Pruning rereads eligible reports before deletion. Archiving verifies copied bytes with streaming checksums, marks completion and keeps originals. Inspect interrupted quarantine/partial-archive directories before cleanup. [Audit](AUDIT.md) records resource and filesystem-race limitations.
