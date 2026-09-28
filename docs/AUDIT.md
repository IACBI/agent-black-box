# Project audit — 2026-09-27, updated 2026-09-28

The review covered CLI entry points, configuration, Git collection, command capture, session lifecycle and catalog, evidence attribution, comparisons, reports, exports, rollback, watching, filesystem utilities, dependencies, scripts, tests, and CI/release configuration. Changes preserve public exports and report schemas. No runtime dependency was added or removed.

The secret-detector source and tests were reviewed from copies supplied directly by the user after a local hook blocked source reads based on their filenames. No hook was changed or bypassed. This completed the outstanding source review and revealed the JWT scanning issue described below. The separate watcherless detector in `src/analyze/analyzer.ts` was also reviewed. The security skill has no Node CLI-specific reference, so web-server guidance was not applied to this CLI.

## Applied fixes

| ID      | Priority              | Finding and change                                                                                                                                                                                                                                                                | Evidence                                                                                            |
| ------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| AUD-001 | High: privacy         | Header redaction selected `=` even when `:` was the actual assignment delimiter. A value such as `Authorization:Bearer confidential=value` could retain credential text in the recorded key. Direct and nested assignments now redact after the first delimiter.                  | `src/commands/commandRecorder.ts:111`, `:267`; regression tests in `tests/commandRecorder.test.ts`. |
| AUD-002 | Medium                | `abb run` accepted syntactically valid active state without checking repository, session location, or lock ownership. It now uses the existing recovery validator before executing a command.                                                                                     | `src/commands/commandRecorder.ts:34`; tampered-directory and owner-token regressions.               |
| AUD-003 | Medium                | Missing configuration skipped validation of default storage, allowing a pre-existing linked `.agent-black-box` directory to escape. `sessionDir: "."` also placed state files in the repository's parent. Both cases now require the existing explicit external-storage override. | `src/config/config.ts:51`, `:116`; junction and parent-directory tests.                             |
| AUD-004 | Medium                | The watcher followed directory links by default, which could observe external trees and consume unnecessary watch resources. It now watches links themselves without traversing their targets.                                                                                    | `src/watcher/watcher.ts:31`; watcher options regression.                                            |
| AUD-005 | Medium                | Size-limited reads checked metadata, then read the entire file; growth after the check could bypass the memory bound. The reader now opens one handle, validates regular-file status, reads bounded chunks with a one-byte overflow probe, and closes in `finally`.               | `src/utils/files.ts:28`; UTF-8 boundary, empty-file, invalid-limit, and stale-size tests.           |
| AUD-006 | Medium: data loss     | Copyable rollback commands used shell quoting but still allowed Git wildcard/pathspec interpretation. Previews and manual report commands now use the literal top-level pathspec already used by apply.                                                                           | `src/rollback/rollback.ts:83`; `src/reports/markdown.ts:384`; report/preview regressions.           |
| AUD-007 | Medium: recovery      | A permission-denied process probe was treated as proof of a dead process. `EPERM` now conservatively keeps the session live, while `ESRCH` remains absent.                                                                                                                        | `src/session/sessionManager.ts:389`; process-probe regression.                                      |
| AUD-008 | Dependency advisories | Patched Vitest and its coverage package from 4.1.10 to 4.1.11 and transitive nanoid from 3.3.17 to 3.3.19. pnpm also refreshed compatible transitive picomatch/WASM packages while resolving the graph. Runtime dependency versions are unchanged.                                | `package.json`, `pnpm-lock.yaml`; fresh registry audit.                                             |
| AUD-009 | Correctness           | The global external-session-directory override was not forwarded to command recording. `abb run` now honors it without persisting it to config.                                                                                                                                   | `src/cli.ts:223`; end-to-end external-storage command test.                                         |
| AUD-010 | Efficiency            | Untracked line counting created a normalized string and an array for every line. A single scan now counts newlines with constant auxiliary space and preserves CRLF/unterminated-line behavior.                                                                                   | `src/git/git.ts:294`; empty, CRLF, and unterminated-file tests.                                     |

Dependency references: [Vitest advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9), [nanoid advisory](https://github.com/advisories/GHSA-2v37-7h3g-55p8). These affect development tooling in this project; the reviewed configuration uses Node tests, not an exposed browser mock server. No exploit against this project's normal test workflow was demonstrated.

## Dead code and architecture

**AUD-012 — adversarial JWT scanning cost (resolved):** The JWT regular expression retried a greedy scan at every `eyJ` prefix, causing quadratic work on nonmatching text. Local isolated measurements of the old expression took 54 ms for 6,000 bytes, 258 ms for 12,000 bytes, and 751 ms for 24,000 bytes. Detection now scans components once, preserving substring matching, allowed characters, minimum component lengths, finding order, and redacted output. The complete updated line detector processed 24,000 bytes in approximately 0.08 ms and 510,000 bytes in 1.4 ms in a local smoke benchmark; these are single-run measurements, not a cross-platform performance guarantee. Other boolean matchers no longer need global-regex state resets. Regression tests compare against the previous expression on 1,125 bounded combinations, exercise a 120,000-byte repeated-prefix input, and verify a valid value after that input. Additional tests cover all five formats, byte limits, line numbers, deduplication, deleted/binary/missing files, and rejected absolute/traversal paths. These changes are in `src/risks/secretDetector.ts` and `tests/secretDetector.test.ts`.

**AUD-013 — Unicode entropy calculation (resolved):** The exported entropy helper counted Unicode code points but divided by UTF-16 code units. A string containing only repeated supplementary characters incorrectly had nonzero entropy. The denominator now counts the same code points as the frequency map. Regression tests cover empty input, a repeated emoji, and equally frequent ASCII/emoji characters. Secret-scanning candidates remain ASCII, so detection thresholds and existing ASCII behavior are unchanged.

**AUD-011 — CI verification gaps (resolved):** The quality job now typechecks source, tests, and scripts. The supply-chain job audits development dependencies as well as production dependencies using the existing high-severity threshold, and builds before inspecting package contents. These changes are in `.github/workflows/ci.yml`; hosted execution still requires CI.

The reachability check covered 27 source modules in the initial audit and 28 after staged analysis was added, along with all three runtime packages. Knip and TypeScript unused-symbol checks found no justified removals. Helpers reachable through `src/index.ts` were retained to preserve the existing API. The watcherless analyzer and session detector have different output contracts and rules; merging them during an audit would risk behavior changes. Existing bounded concurrency, atomic report writes, append-only event storage, and compact catalog metadata remain intact.

## Follow-up hardening — 2026-09-28

- Session finalization now closes command registration, waits for live wrapped commands to append their events, and records a warning for an interrupted command. This addresses the ordinary finalize-versus-command race; it is not an atomic transaction against another process deliberately changing session files.
- The watcher persists capture-loss markers for queue overflow, failed event writes, and watcher errors. Reports include counts when known and an explicit unknown-count warning after recovery.
- `rollback --apply` now requires a private end-state snapshot and rechecks HEAD, index, status, content hashes, file mode, and resolved parent location before preview and immediately before restore. A changed or unverifiable path is refused. The direct exported `applyRollbackPlan` function remains available for API compatibility and does not perform this preflight.
- `analyze --staged` reads bounded Git index blobs, independent of working-tree content. Text, JSON, and SARIF output expose skipped paths and reasons for both staged and worktree analysis.
- Text-file inspection now checks physical parent location and the opened file's identity and metadata around a bounded read, reducing linked-ancestor escapes and replacement races.
- Windows `.cmd`/`.bat` execution now preserves tested spaces and shell metacharacters using verbatim `cmd.exe` arguments. Percent signs and line breaks are refused for batch arguments because `cmd.exe` can expand or reinterpret them. The refusal is recorded as a command error.

The new Windows-only batch fixture exercises a script path with spaces and real argument forwarding. A 15-second Windows test timeout accommodates intermittent Git fixture delays; other platforms retain Vitest's default. No runtime dependency was added.

## Remaining risks and recommendations

These were not silently changed because they need stronger lifecycle guarantees, threat-model decisions, or broader compatibility testing.

1. **Medium — extreme session size.** The 32 MiB catalog mismatch is addressed by a versioned replay sidecar for large reports while preserving full `session.json`. Finalization now explicitly refuses reports over 256 MiB and retains raw NDJSON logs. Such a session requires manual evidence handling rather than a misleading partial completed report. Streaming or paged APIs would be needed to support still larger sessions without unbounded memory use.
2. **Medium — local filesystem trust boundary.** Handle checks reduce accidental linked-ancestor and replacement problems, but concurrent mutation by a hostile process with the same filesystem access cannot be made atomic with the current path-based Git and Node APIs. The rollback preflight and retention deletion both have a final check-to-operation gap. Treat repository and session storage as locally trusted.
3. **Low — CI execution evidence.** The typecheck, development dependency audit, and build-before-pack steps are configured (AUD-011). Their hosted execution, the cross-platform matrix, and CodeQL still require GitHub CI. Local commands have been verified; no hosted result is claimed.
4. **Low — privacy/portability limits.** Metadata redaction is heuristic: arbitrary shell snippets and free-form text are not a guaranteed secret boundary. URL user information, option-wrapped URLs, sensitive JSON keys, and assignment-like labels are now covered, but repository/session data must still be reviewed before sharing. Manual rollback snippets use POSIX shell syntax; Windows users should use an appropriate shell.
5. **Low — batch-script semantics.** A batch script can reinterpret arguments internally, especially after enabling delayed expansion or forwarding through extra command-shell layers. The tested wrapper rejects percent signs and line breaks; callers needing arbitrary argument bytes should invoke a native executable directly.

## Validation

Validated locally on Windows with Node.js 24.12.0 and pnpm 10.30.3:

- Formatting, ESLint, TypeScript, both dead-code checks, and production build passed.
- Coverage run: 22 test files passed; 118 tests passed and one existing Windows-incompatible file-symlink test was skipped. Coverage: 84.31% statements, 72.67% branches, 88.62% functions, 84.14% lines; all configured thresholds passed. The secret detector has 100% statement/line coverage and 97.22% branch coverage.
- Full and production dependency audits reported zero known advisories.
- Frozen-lockfile installation passed without running dependency lifecycle scripts.
- NDJSON benchmark: 100,000 events in 620 ms; measured heap delta 5.6 MiB, within the 5,000 ms / 256 MiB budgets. This verifies the existing ingestion benchmark, not a measured speedup of line counting.
- Release metadata validation, package dry run (including built CLI/modules), built CLI help, and whitespace checks passed.
- Linux/macOS, Node 22, GitHub-hosted CI, and CodeQL were not executed locally.

Initial dependency installation was incomplete; it was restored from the frozen lockfile before applying advisory patches. Coverage runs repeatedly hit the five-second filesystem/Git fixture timeout under concurrent Windows execution. Windows tests are now serialized and have a 15-second timeout; other platforms retain their default parallelism and timeout. Coverage thresholds are unchanged. New test fixtures were corrected to keep external-storage state inside their own temporary directory. The coverage report also identifies `src/reports/sessionCatalog.ts` as lacking direct in-process coverage; CLI subprocess smoke tests do not contribute to its coverage totals.

The follow-up full `pnpm check` passed on Windows: formatting, lint, typecheck, both dead-code checks, build, and coverage. Coverage run: 23 test files passed; 129 tests passed and one Windows-incompatible file-symlink test was skipped. Coverage was 84.51% statements, 73.95% branches, 89.42% functions, and 84.29% lines. The full dependency audit found no known vulnerabilities. The 100,000-record NDJSON benchmark completed in 384 ms with a 5.6 MiB measured heap delta, within its 5,000 ms / 256 MiB budgets.

## Professionalization follow-up — 2026-09-28

- Large reports keep the complete `session.json` API contract. A versioned sidecar allows bounded replay above 32 MiB, with hashes and record-count checks. Finalization refuses reports above 256 MiB while preserving raw logs.
- `analyze --staged --baseline <ref>` compares potential secret findings against a fixed commit by path and exact line occurrence count. Unchanged matches are suppressed without printing their values; risk metadata remains in scope.
- Baseline comparison now uses Git-identified source paths for renames when the destination did not exist in the selected commit. Sources excluded by configuration are not used for suppression. Command metadata redaction now covers hyphenated header names, option-wrapped URLs, URL usernames, sensitive-key JSON arguments, and assignment-like labels.
- `sessions list` now filters by state, UTC date, minimum severity, file path, recorded redacted command, risk category, and result limit. New reports carry a bounded search index; older reports fall back to validated report content.
- `sessions prune --before <date>` previews deletion and preserves at least the newest completed session. `--apply` requires typed interactive confirmation and rechecks active state, catalog identity, report readability, physical paths, and linked content. Incomplete and corrupt sessions are excluded. An interrupted deletion can leave a `.pruning-*` directory for manual recovery.
- The performance script now measures report writing, legacy catalog fallback, and analysis of 5,000 changed files in addition to 100,000 NDJSON records. These are broad regression budgets, not latency guarantees.

On Windows, the expanded full check passed with 25 test files, 139 passing tests, and two skipped platform-specific symlink tests. Coverage was 86.11% statements, 79.11% branches, 92.01% functions, and 85.79% lines. The full dependency audit reported no known vulnerabilities, package dry run and release metadata validation passed, and the local performance scenarios finished below budget. Hosted CI on Linux, macOS, Windows, and Node 22/24 still needs GitHub execution.

The subsequent rename and metadata-redaction follow-up passed the full quality suite with 25 test files, 142 passing tests, and the same two Windows symlink skips. Coverage was 86.45% statements, 79.51% branches, 92.09% functions, and 86.14% lines. The full dependency audit again reported no known vulnerabilities; package and release checks passed. The performance run completed 100,000 NDJSON records in 144 ms with a 5.6 MiB measured heap delta, 5,000-event report writing in 69 ms, legacy catalog fallback in 14 ms, and 5,000-file analysis in 11 ms. These are local single-run measurements, not cross-platform guarantees.

The retention link-safety test now uses a directory link, including a Windows junction, so it runs on all supported platforms. The final local full check passed 143 tests with one unrelated Windows file-symlink test skipped; statement, branch, function, and line coverage were 86.50%, 79.56%, 92.09%, and 86.18% respectively.

## Existing features worth enhancing

- Support reports beyond the explicit 256 MiB policy with streaming or paged APIs if real usage requires them.
- Consider exposing rename-source provenance in structured analysis output if reviewers need to audit why a finding was suppressed.
- Bring watcherless and recorded-session findings into closer semantic alignment through shared fixtures before any consolidation.
- If real sessions exceed the current report policy, design paged or streaming report APIs and validate them with production-size fixtures.

## New features aligned with the project

- An optional local terminal history browser on top of the new CLI filters.
- Configurable retention policies and archival destinations on top of the current preview-and-confirm prune command.
- Review policies for allowed dependency/config changes, producing local CI findings without external services.
- Optional policy profiles for deciding which _new_ staged findings should fail CI.
