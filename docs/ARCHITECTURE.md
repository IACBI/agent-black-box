# Architecture

A local TypeScript CLI for reviewing Git state, file events and explicitly wrapped commands. See [Usage](USAGE.md) for commands and [Reports](REPORTS.md) for artifacts and verification levels.

## Modules

| Module                             | Responsibility                                                           |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `cli.ts`, `index.ts`               | CLI orchestration and public exports.                                    |
| `config/`, `doctor/`               | Configuration, storage validation and diagnostics.                       |
| `git/`, `utils/`                   | Git snapshots, bounded inspection, paths, persistence and concurrency.   |
| `watcher/`, `commands/`            | File capture and command execution/redacted metadata.                    |
| `session/`                         | Ownership, recovery, logs, evidence, history, retention and archives.    |
| `risks/`, `analyze/`               | Separate recorded-session and watcherless/staged detectors; CI policies. |
| `reports/`, `export/`, `rollback/` | Reports, exports and explicit guarded restore.                           |

## Data flow

1. Initialization exclusively publishes versioned `.agentblackbox.json`; validation/migration enforces the configuration contract.
2. Creation captures HEAD/branch/index and pre-existing changes, allocates a timestamp/random ID, acquires an owner-token lock and exclusively creates its directory. Legacy IDs remain readable.
3. The watcher appends file events. `abb run` records redacted metadata without terminal output; stop validates ownership.
4. Finalization blocks new command registration, waits for live wrappers, reads logs and collects final Git/net HEAD changes. Baseline, observations and Git metadata determine attribution.
5. Session-relevant changes feed recorded risk/secret review. Reports are published atomically per file; completion metadata is written last. Capture-loss diagnostics survive recovery.
6. History uses metadata/search indices with report fallback. Structural reads reconstruct large reports; streaming uses lighter verification. Pruning validates records; archives verify copies and preserve originals.

Watcherless analysis reads worktree files; staged analysis reads index blobs. Fixed-commit baselines suppress matching secret-like lines by occurrence count and use Git-established rename sources. `new-secrets`/`complete-review` define CI criteria and required coverage. Recorded/watcherless heuristics remain separate; see [Usage](USAGE.md).

## Safety boundaries

Runtime requires no external API, telemetry or private agent integration. Detectors redact supported patterns and emit heuristic signals. Commands execute caller-selected executables, without a sandbox.

Storage stays physically inside the repository unless explicitly allowed for trusted local external paths; UNC/network storage is blocked. Inspection rejects linked files/external ancestors; command cwd stays inside the physical repository. Same-user path races remain possible.

State/config/metadata reads are bounded and validated. Stop/recovery require matching state/lock ownership; corrupt/ambiguous state is preserved. Recovery verifies completed reports before clearing stale state. Initialization publishes a fully written file exclusively through a hard link. State/reports and forced exports use atomic rename; ordinary exports use exclusive creation. See [Reports](REPORTS.md) for verification levels.

Rollback defaults to guidance. CLI apply requires the latest session, eligible tracked files and typed confirmation; pre-existing changes are excluded. HEAD/index/file identity is rechecked before restore to HEAD. Library caller boundaries and hard-link support/race limits are in [Security](../SECURITY.md) and [Audit](AUDIT.md).

## Bounded resource use

Watching excludes heavy/generated/storage directories and bounds its queue. NDJSON is streamed with a 1 MiB line limit, 1,000,000 accepted records per log and bounded warnings; discarded records are explicit diagnostics.

Inspection classifies text/binary/large/missing/non-regular paths. CLI worktree, staged and baseline reads cap bytes at the configured limit or 256 KiB, whichever is smaller. The public analyzer defaults to 262,144 JavaScript string characters; callers can configure that limit. Untracked estimates read small text files. Git/recorded-secret inspection uses deterministic concurrency capped at eight workers and available CPUs.

Reports retain full JSON under a 256 MiB policy; see [Reports](REPORTS.md) for replay/index limits. Pruning materializes bounded records and uses more memory than listing/streaming. Retention defaults do not schedule background work.

Durations use a monotonic clock; index fingerprints store metadata/blob identities. `pnpm perf` measures regression budgets, not peak-memory or cross-platform guarantees.
