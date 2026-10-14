# Changelog

## Unreleased

## 0.10.0

- Pin capture-log reads to regular file descriptors, bound reads to the opened length plus one byte, and verify exact file identity/timestamps after parsing. Reject links, replacements, and concurrent growth while preserving read/close failures and raw evidence.
- Compare worktree file identities with exact integers and verify the pathname after reading, preventing rounded Windows identities or renamed files from appearing as a stable scan.
- Serialize hook install/update/forced backup/uninstall across ABB processes using an exclusive owner lock. Preserve uncertain/stale/replaced locks for inspection; no automatic takeover or lock bypass is introduced.
- Add opt-in `recover --max-rss-mb` / `FinalizeSessionOptions.maxRssBytes` checkpoints for observed whole-process RSS alongside record/byte quotas. Refusals preserve evidence and allow retry; this is not a hard OS memory cap.
- Recognize known credentials concealed in one bounded JSON string-escape layer across recording and analysis. Hide the entire affected command argument, retain original execution arguments, and keep findings free of raw/decoded credentials.
- Add race/failure/encoding regressions and RSS/escaped-literal performance budgets; document operational boundaries and stale-lock recovery.

## 0.9.0

- Add opt-in `recover --max-records` and `FinalizeSessionOptions.maxRecords` to bound combined event/command record retention alongside byte limits, preserving evidence and allowing exact-boundary retries.
- Add structured public issue forms, a private vulnerability-reporting route, a PR review checklist, CODEOWNERS, and documented single-maintainer PR protections and future independent-review requirements. Verify the protected main source before release; protect existing version tags against updates and deletion.
- Document resource-constrained recovery, trusted storage, process isolation, and layered credential-detection precautions without claiming hard RSS bounds or atomic filesystem safety.
- Combine built-in, embedded-script, and custom command credential matches on original input, preventing overlapping rules from exposing credential fragments. Ambiguous structural rewrites redact the whole argument; execution receives unchanged arguments.
- Preserve POSIX backslash filenames as distinct paths during analysis and baseline comparison, while retaining Windows separator handling and strict unsafe-path validation.
- Reject oversized retained capture records before finalization exceeds the existing 256 MiB report policy. Add optional recovery record budgets and live-command wait limits, preserving evidence and ownership on refusal and allowing safe retries.
- Strip inherited Git pathspec modes so staged exclusions, literal baseline paths, and secret-policy gates retain their defined behavior.
- Refuse displaced session directories before recovery writes, check archive destination containment before directory creation, and preserve concurrently created foreign hooks during installation.
- Avoid argument-stack overflow when a bounded file produces many findings; add meaningful failure-mode regressions and composed-redaction/record-retention performance budgets.

## 0.8.4

- Fixed rounded Windows file-identity comparisons during evidence hashing by using exact integer metadata; added collision and unsupported-length regressions.
- Added optional Ed25519 evidence sealing with encrypted external signing keys and independently supplied trusted public keys; signature-required verification rejects unsigned replacements without changing existing evidence formats.
- Expanded shared credential signals and command redaction, isolated custom regex execution behind time and memory limits, and documented authenticity boundaries and detection limitations.
- Bound large-report replay data to streamed canonical JSON core and record digests, including coordinated replay/log inconsistencies, without changing stored report formats.
- Added possible-secret location/count comparisons that omit credential values and stored excerpts.
- Added explicit `sessions verify --check-indexes` and `--repair-indexes` for derived metadata/search consistency, with canonical evidence, ownership, link, and budget guards.
- Added read-only partial-archive inspection and verified `sessions archive --resume --apply`, preserving matching files and refusing divergent copies.
- Added shared `analyze --max-total-bytes` content budgets and Git blob metadata preflight to avoid reading oversized bodies while retaining explicit coverage diagnostics.
- Preserved atomic write/close/cleanup failures, stopped asynchronous work from outliving failed capture operations, rejected malformed stored findings, and bounded rollback hashing of growing files.
- Screen unsafe configured regex shapes before compilation or execution, with rejection regressions through the repository configuration boundary.
- Added opt-in history read/search budgets, visible unavailable-metadata diagnostics, and exact parsed-byte verification for budgeted large reports without changing storage limits or defaults.
- Added explicit initial staged analysis and managed hook opt-ins for first-commit policy enforcement and persisted trusted external-storage authorization.
- Exposed Git-verified rename sources on text/SARIF findings while preserving destination locations and JSON comparison contracts.
- Fixed filesystem failure classification, report publication settlement, credential redaction gaps and large Git baseline read/write limits; batched baseline tree lookups with bounded arguments.
- Added opt-in working-data budgets and worker limits to streaming session verification, with bounded legacy catalog fallback and explicit budget refusals.
- Added read-only persisted capture-health diagnostics to status JSON/text and doctor, with bounded inspection and private ownership fields omitted.
- Added validated named staged CI policies for independent secret, coverage, and metadata-risk gates; existing built-in policies remain unchanged.
- Serialized finalization/recovery claims, retained failed command-capture evidence, and made stop polling single-flight.
- Hardened Windows command-interpreter resolution and terminal/rollback rendering; upgraded simple-git and pinned vulnerable transitive dependencies.
- Expanded regression coverage and performance checks while preserving report formats and default behavior.
- Added `abb hook install|uninstall|status`, a managed Git pre-commit hook that runs `abb analyze --staged` with a chosen policy. It never replaces a hook it did not write without `--force` (which keeps a `pre-commit.pre-abb` backup), refuses hooks directories outside the repository, validates the policy name before it reaches the shell script, and fails open when `abb` is not on PATH.
- Added `secretPatterns` and `secretAllowlist` to `.agentblackbox.json` (and the JSON schema). Patterns are screened for empty matches, backreferences, and nested quantifiers and are applied to recorded sessions, `abb analyze` (both sides of a baseline comparison), and command redaction. Allowlist entries require a reason; hidden findings are counted in `analyze` output and as `riskSummary.allowlistedSecretCount` in session reports.
- Added `abb pr-comment` (a size-capped, escaped Markdown summary for a pull request) and `abb export --format sarif` (SARIF 2.1.0 for a recorded session, with stable fingerprints and capture warnings). Neither uploads anything.
- Secret detection now catches assignments whose keyword is part of a longer name (`OPENAI_API_KEY=`) or a quoted key (`"apiKey":`), and recognises private-key headers, Stripe live keys, Google API keys, and LLM API keys.
- Command redaction now covers passwords in any URL scheme, `passphrase`/`pwd`/`credential` names, credentials inside script arguments (`sh -c "export TOKEN=..."`), bare provider tokens, and the short credential flags of `curl`, `mysql`, `redis-cli`, `sshpass`, and `docker`/`podman login`.
- Fixed rollback path identity on POSIX: a file named `a\b` is no longer recorded or restored as `a/b`. Backslashes still separate path components on Windows and in exclude patterns.
- A `retention.archiveDir` from repository configuration must now stay inside the repository; an external destination needs an explicit `--to`.
- Made bidirectional marks and overrides visible in terminal output and Markdown reports, and resolved Windows commands with dotted names such as `python3.12` through PATHEXT.
- Staged and baseline analysis read blobs through one `git cat-file --batch` process, the watcher writes bursts of file events in ordered batches, markdown escaping is linear-time, and finalization overlaps independent reads. Output is unchanged.
- `package.json` now declares `main` and `types` so the library can be imported by package name; `release:validate` checks the entry points, the CLI shebang, and that the CLI version matches `package.json`.
- Non-forced exports are created with owner-only permissions, and the release workflow no longer persists checkout credentials.
- Moved analysis rendering and working-tree collection out of `src/cli.ts`, removed duplicated helpers, and enabled `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, and `noFallthroughCasesInSwitch` for source and scripts.
- End-to-end tests now run the compiled CLI and isolate Git from the developer's global configuration; the documentation test compares every CLI command and long option with the docs.

## 0.8.3

- Added `abb sessions verify [session]` (and `verifySessions` in the library) to check stored session reports read-only, with `--json` output and a non-zero exit when a report fails.
- Closed a Windows hijack: process creation searches the current directory first, so a `git.exe` (or any bare command) planted in a reviewed repository could run. Git and bare command names now resolve only through absolute PATH entries in PATHEXT order; unresolved names report `ENOENT`. This also fixes bare `.bat`-only commands. Verified with a planted `git.exe` on real Windows CI.
- Documented a pre-commit hook recipe for the `new-secrets` policy, verified against a real repository.
- Removed four unused helpers (`readJsonFile`, `getNewestDirectory`, `getLatestSessionDir`, `findFileChangeEvidence`).
- Made path exclusion about 7x faster on large trees by normalizing each path once, skipping regex passes for already-normalized paths, and matching segments without allocation.
- Consolidated eight duplicated directory-containment checks into one shared helper with regression coverage.
- Removed a redundant per-line deduplication pass in the secret detector and a quadratic status lookup during rollback verification.

## 0.8.2

- Handled command startup failures, disappearing scan paths, exact staged-content size limits, and malformed catalog Git fields explicitly.
- Prevented concurrent initialization overwrites, verified replay records before pruning, and made forced exports atomic.
- Corrected large Git line counts and session-directory diagnostics; added detector keyword, redaction, and deduplication regressions; verified repository containment through directory links.
- Expanded Windows command-wrapper tests with injection payloads.
- Consolidated documentation into usage, reports, architecture, security, and contributor guides; removed the point-in-time audit report and the redundant repository `.agentblackbox.json` (built-in defaults are identical).

## 0.8.1

- Fixed costly assignment matching on whitespace-heavy analyzer input and detected sensitive assignments after earlier values on the same line.
- Validated session ownership before sending stop requests and preserved corrupt state for diagnosis.
- Verified completed reports before cleaning stale session state, rather than trusting completion metadata alone.
- Added random session ID suffixes and exclusive directory creation to prevent overwriting evidence when timestamps repeat; existing IDs remain selectable.
- Rejected linked report files and checked file identity before streaming their contents.
- Removed duplicate SARIF rule descriptors and encoded file locations as URI references.
- Measured command duration with a monotonic clock so system time adjustments cannot discard valid command records.
- Added regression coverage and an adversarial analyzer performance budget; updated usage, architecture, report, and audit documentation.

## 0.8.0

### Review and history

- Added staged analysis with fixed-commit baselines, count-aware secret suppression, and Git rename-source provenance in text, JSON, and SARIF.
- Added `new-secrets` and `complete-review` CI policies, including explicit scan-coverage diagnostics.
- Added filtered session history, interactive browsing, retention previews, and verified copy-only archives with optional configuration defaults.
- Preserved full JSON reports with verified replay above 32 MiB and an explicit 256 MiB finalization limit that retains raw logs.

### Safety and reliability

- Added rollback end-state checks, command-finalization coordination, and persistent watcher capture-loss warnings.
- Fixed adversarial JWT scanning cost, Unicode entropy calculation, header redaction, literal rollback path handling, and Windows batch argument quoting.
- Added atomic state/report writes, physical repository containment for command working directories, and no-follow file inspection.
- Expanded command metadata redaction for nested assignments, headers, URL credentials, and sensitive query parameters.
- Streamed NDJSON finalization with bounded records, line sizes, and diagnostics.

### Maintenance and documentation

- Raised the supported runtime baseline to Node.js 22 and added a Node.js 22/24 Linux, Windows, and macOS CI matrix.
- Updated the pinned CodeQL Action steps together to v4.38.2 and refreshed development tooling and Node.js type definitions.
- Added deterministic bounded concurrency for Git file inspection and possible-secret scanning.
- Added large-session performance budgets, release version checks, production dependency audits, and release checksums.
- Focused the README on English and Turkish; consolidated the audit and updated usage, architecture, contributor, and release guidance.

## 0.7.0

- Rejected repository-external and UNC session directories by default, with an explicit trusted-local override.
- Bounded config, session-state, and session-catalog JSON reads to prevent oversized local input from exhausting memory.
- Added a stable CI required-check gate and signed release artifact provenance attestations.
- Added compact `session-metadata.json` files for efficient history listing without reading every full report.
- Added a backward-compatible session catalog that classifies complete, incomplete, and corrupt sessions.
- Added safe selection by `latest`, exact session ID, or unique session ID prefix.
- Added `abb sessions list`, `abb sessions show`, and `abb sessions compare` with human-readable and JSON output.
- Added `--session` selection to report, summary, commands, timeline, risks, rollback, and export commands.
- Added file, risk, command-frequency, and HEAD comparison across completed sessions.
- Prevented interactive rollback apply from using older completed sessions.
- Added unit and end-to-end coverage for legacy reports, corrupt metadata, ambiguous selectors, and two-session workflows.
- Hardened rollback apply with literal Git pathspecs and blocked historical-session apply operations.
- Corrected pnpm development command examples across all 12 README language sections.
- Fixed foreground watcher shutdown so completed sessions release signal listeners and exit cleanly.
- Hardened Markdown code blocks and session stop-state parsing against repository-controlled or malformed input.
- Supported bare Windows `.cmd` and `.bat` command shims while keeping command execution shell-disabled.

## 0.6.0

- Made the tag-driven release workflow idempotent when a GitHub Release already exists for the tag.
- Updated release documentation to avoid manual release creation before tag pushes.
- Added a persisted Git start baseline with HEAD, branch, index fingerprint, and pre-existing changed paths.
- Added change evidence that separates pre-existing paths, watcher observations, final-state changes, and transient observations.
- Added start-to-end HEAD tree comparison so committed changes remain visible when the final worktree is clean.
- Limited risk and possible-secret analysis to session-relevant final changes when a start baseline is available.
- Prevented interactive rollback from restoring files that already had changes at session start.
- Added baseline and attribution details to JSON, summary, timeline, diff, risk, and rollback reports.
- Added multilingual README parity coverage for all 12 in-page language sections.

## 0.5.3

- Hardened Markdown report rendering for repository-controlled paths, command metadata, risk text, and integrity warnings.
- Hardened shell command previews in rollback reports by using single-quoted path arguments and neutralizing line breaks.
- Added regression coverage for Markdown table escaping and shell-sensitive rollback path previews.

## 0.5.2

- Replaced short localized README blurbs with full in-page documentation sections for 11 non-English languages.
- Removed unnecessary explanatory text from the README language selector.
- Updated supporting docs to point to the full localized README documentation.

## 0.5.1

- Added a multilingual README language index with in-page anchors.
- Added local documentation references from usage, reports, and demo docs back to the README language section.
- Merged Dependabot's GitHub Actions maintenance update for `actions/checkout`.

## 0.5.0

- Added shared binary/text file inspection for Git snapshots and possible secret scanning.
- Improved untracked file diff metadata with file kind, size, line-stat source, and skipped-line notes.
- Added command grouping and phase metadata through `abb run --group` and `abb run --phase`.
- Updated command, timeline, summary, and diff reports to show group, phase, file kind, size, and stat-source details.
- Added coverage for binary detection, large-file classification, grouped command reporting, and updated CLI E2E behavior.

## 0.4.0

- Added versioned config support with JSON Schema, validation, and migration commands.
- Added atomic session locks, stale lock recovery, and corrupted event record recovery.
- Added deterministic risk scores and risk summary metadata to session reports.
- Added filtered `abb risks` output with severity, category, and JSON modes.
- Added `abb export` for bundled Markdown or structured JSON session exports.
- Updated tests and documentation for config migration, session recovery, risk filtering, and exports.

## 0.3.0

- Added CLI end-to-end coverage for real `init/start/run/stop/report` workflows.
- Added `abb doctor` for local environment, config, repository, and session diagnostics.
- Added `summary.md` and `abb summary` for concise review-first session output.
- Added `commands.md` and `abb commands` for command metadata review.
- Added safe interactive rollback apply mode for eligible tracked files.
- Extended `abb run` with `--cwd` and `--label`.
- Added release preparation docs and a release validation script.

## 0.2.0

- Added `abb run -- <command>` for opt-in command metadata recording during active sessions.
- Added redaction for sensitive command-line assignments and flags.
- Added estimated added-line counts for small untracked text files.
- Added CodeQL and tag-based release workflows.
- Reworked documentation for a clearer user journey and maintainer workflow.

## 0.1.0

- Initial Agent Black Box MVP.
- Added local-first CLI commands for session recording, status, reports, timeline, risks, and rollback hints.
- Added Git snapshot collection, file watching, risk detection, possible secret detection, Markdown reports, and JSON session output.
