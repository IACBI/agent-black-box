# Architecture

A local TypeScript CLI for reviewing Git state, file events and explicitly wrapped commands. See [Usage](USAGE.md) for commands and [Reports](REPORTS.md) for artifacts and verification levels.

## Modules

| Module                             | Responsibility                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `cli.ts`, `index.ts`               | CLI orchestration and public exports (`main`/`types` in `package.json`).                                                 |
| `config/`, `doctor/`               | Configuration, storage validation and diagnostics.                                                                       |
| `git/`, `utils/`                   | Git snapshots, bounded inspection, paths, persistence and concurrency.                                                   |
| `watcher/`, `commands/`            | File capture and command execution/redacted metadata.                                                                    |
| `session/`                         | Ownership, recovery, logs, evidence, history, verification, retention.                                                   |
| `risks/`, `analyze/`               | Separate recorded-session and watcherless/staged detectors; CI policies; shared custom secret rules; analysis rendering. |
| `hooks/`                           | Managed Git pre-commit hook (install, status, uninstall).                                                                |
| `reports/`, `export/`, `rollback/` | Reports, exports (Markdown, JSON, SARIF), pull request comments and explicit guarded restore.                            |

## Data flow

1. Initialization exclusively publishes versioned `.agentblackbox.json`; validation/migration enforces the configuration contract.
2. Creation captures HEAD/branch/index and pre-existing changes, allocates a timestamp/random ID, acquires an owner-token lock and exclusively creates its directory. Legacy IDs remain readable.
3. The watcher appends file events. `abb run` records redacted metadata without terminal output; stop validates ownership.
4. Finalization blocks new command registration, waits for live wrappers, reads logs and collects final Git/net HEAD changes. Baseline, observations and Git metadata determine attribution.
5. Session-relevant changes feed recorded risk/secret review. Reports are published atomically per file; completion metadata is written last. Capture-loss diagnostics survive recovery.
6. History uses metadata/search indices with report fallback. Replay-backed reads bind the compact core and record digests to streamed canonical JSON before trusting sidecar metadata. Explicit index verification/repair derives disposable indexes from verified evidence. Pruning validates records; archives verify copies and preserve originals, with opt-in continuation of matching partial copies.

Watcherless analysis reads worktree files; staged analysis reads index blobs. Fixed-commit baselines suppress matching secret-like lines by occurrence count and use Git-established rename sources. `new-secrets`/`complete-review` define CI criteria and required coverage. Recorded/watcherless heuristics remain separate; see [Usage](USAGE.md).

Explicit initial-commit analysis requires staged input and an unborn HEAD; all content findings are new and there is no synthetic baseline. Managed hooks retain external-storage authorization and initial policy selection only through explicit opt-ins; their defaults remain unchanged.

Optional `secretPatterns` and `secretAllowlist` are validated once in `config/secretRules.ts` and compiled into one shared rule set (`risks/secretRules.ts`). The recorded-session detector, the watcherless analyzer (including both sides of a baseline comparison) and command redaction all use it, so a pattern or exception means the same thing everywhere. Hidden findings are counted, not silently dropped.

Optional named `analysisPolicies` are validated and selected explicitly. Metadata-risk severity/category gates complement independent secret and coverage gates; evaluation retains all findings. Existing built-in policy behavior and result shapes are preserved.

## Safety boundaries

Runtime requires no external API, telemetry or private agent integration. Detectors redact supported patterns and emit heuristic signals. Commands execute caller-selected executables, without a sandbox.

Storage stays physically inside the repository unless explicitly allowed for trusted local external paths; UNC/network storage is blocked. Inspection rejects linked files/external ancestors; command cwd stays inside the physical repository. Same-user path races remain possible.

State/config/metadata reads are bounded and validated. Stop/recovery require matching state/lock ownership; corrupt/ambiguous state is preserved. Exclusive per-session generation claims serialize finalization and recovery, with the primary lock held through cleanup. Dead claims remain immutable; incomplete or unreadable claims require manual inspection. Failed command writes retain durable markers so recovery reports capture loss without waiting for the wrapper process. Recovery verifies completed reports before clearing stale state. Initialization and ordinary exports publish fully written files exclusively through a hard link; state/reports and forced exports use atomic rename. See [Reports](REPORTS.md) for verification levels.

Completed cleanup exclusively publishes a bounded `session-cleanup.json` receipt before removing active state, releases the primary lock last, then touches only the old session's local receipt/claim. A dead surviving lock without active state can resume cleanup only with a regular receipt, a contained non-linked session directory, matching full ownership identity and lock creation time, and a verified completed canonical report. Existing immutable claims serialize competing recoveries. Missing proof, unreadable state, mismatches, and live owners are preserved; ordinary finalization still requires active state. Atomic file publication protects against process interruption, without promising full power-loss durability across filesystem directory updates.

Rollback defaults to guidance. CLI apply requires the latest session, eligible tracked files and typed confirmation; pre-existing changes are excluded. HEAD/index/file identity is rechecked before restore to HEAD. Library caller boundaries are in [Security](../SECURITY.md).

## Bounded resource use

Watching excludes heavy/generated/storage directories and bounds its queue. NDJSON is streamed with a 1 MiB line limit, 1,000,000 accepted records per log and bounded warnings; discarded records are explicit diagnostics.

Git start baselines use a separate 32 MiB serialized UTF-8 JSON limit for both publication and reading. Size and shape are checked before session ownership is published. Active-session, lock and stop-request state retain their 1 MiB read limit.

Inspection classifies text/binary/large/missing/non-regular paths. CLI worktree, staged and baseline reads cap bytes at the configured limit or 256 KiB, whichever is smaller. The public analyzer defaults to 262,144 JavaScript string characters; callers can configure that limit. Untracked estimates read small text files. Git/recorded-secret inspection uses deterministic concurrency capped at eight workers and available CPUs; the CLI's own reads use four. Staged and baseline blobs first use `git cat-file --batch-check` metadata preflight, then request bounded bodies through `--batch`. Oversized bodies are not inflated or streamed. The watcher writes bursts of file events in ordered batches of up to 256.

Opt-in `analyze --max-total-bytes` shares one retained UTF-8 content quota between current and needed baseline reads. Admissions follow input order; refusals preserve explicit coverage diagnostics. Budgeted worktree reads are serial, while staged/baseline readers transform each bounded blob immediately rather than retaining all raw buffers. The quota excludes transient per-file buffers, decoded strings, parsed objects, and V8 overhead. Failed concurrent maps stop claiming work and drain started operations; watcher failures stop polling/admissions and drain accepted capture writes before returning.

Baseline tree lookups group exact literal pathspecs into batches of at most 64 paths, with a conservative 16 KiB argument budget and four concurrent queries. An individually oversized path retains Git's existing handling. Returned entries are matched to requested paths; input order, duplicates and Git-verified rename sources are preserved.

Reports retain full JSON under a 256 MiB policy; see [Reports](REPORTS.md) for replay/index limits. Replay verification validates canonical JSON grammar, compact core, and canonical record digests, followed by capture-log digests when requested. It retains bounded individual records instead of full arrays. Full reads and finalization still materialize records; pruning uses verified canonical streaming and rechecks the selected canonical timestamp against the preview. Catalog metadata uses batches of 32; report fallback parsing runs one report at a time to avoid simultaneous large allocations. Retention defaults do not schedule background work.

Verification optionally budgets encoded JSON inputs and stream buffers, reducing worker count and metadata batches before inspection. Budgeted catalog fallback derives metadata from the compact core and streamed log digests. Inputs exceeding their quota fail before parsing; inability to obtain catalog timestamps prevents an ambiguous `latest` selection. The quota excludes decoded strings, parsed objects, retained catalog/results, and V8 overhead; it is not an RSS cap.

History listing, browsing, showing and comparison accept the same optional budget with one read worker. Budgeted searches serialize compact-index/report reads and propagate refusals. Missing metadata is visible and prevents ambiguous metadata filters, limits and latest markers. Full budgeted replay reads share their encoded-input quota between stored JSON and replay and verify the exact text parsed. Streaming replay reads charge retained canonical core, replay JSON, and one active canonical record, then verify both canonical and requested capture-log digests. No stored format migration is needed.

Capture-health inspection walks at most 10,000 directory entries and checks durable marker metadata without reading logs or mutating storage. Unknown/linked/malformed markers prevent a healthy conclusion; persisted failures remain degraded even during an incomplete inspection. Doctor and opt-in status diagnostics expose this bounded evidence, not live watcher-buffer health.

Durations use a monotonic clock; index fingerprints store metadata/blob identities. `pnpm perf` measures regression budgets, not peak-memory or cross-platform guarantees.

Optional evidence sealing uses Node crypto Ed25519 and a fixed manifest of canonical evidence files. Trusted verification keys are supplied by callers, never loaded from the evidence or repository config. Custom secret regex execution uses a bounded worker while preserving the synchronous detector APIs. See [Evidence security](EVIDENCE-SECURITY.md) for the signature scope, key-management boundary, and resource limits.
