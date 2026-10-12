# Project audit

Audited revision: `aa37c947ff2b55fe757a7318e671f620024bc13b` (0.8.4), plus the changes described below. Final verification ran locally on Windows with Node.js 22.23.3/24.12.0 and Git 2.52.0.

## Scope and architecture

Reviewed the CLI and public exports, configuration, Git/worktree/staged analysis, secret detection and command redaction, watcher lifecycle, session ownership/recovery, persistence/verification/retention, reports/exports, hooks, rollback, tests, dependencies, and build/CI configuration. Three independent read-only reviews covered security/reliability, analysis/performance, and architecture/tests; findings were revalidated centrally before edits.

The existing flow separates Git baselines, watcher observations, wrapped commands, final evidence, and derived reports. Bounded reads, ownership tokens, isolated custom-pattern evaluation, atomic report publication, and realistic Git/filesystem fixtures are already substantial safeguards. Both dead-code checks passed; no dependency removal or broad architectural rewrite was justified.

## Implemented findings

All six findings had high confidence, small implementation effort, and low change risk. Priority follows privacy, recoverability, and valid-input failure impact.

### High privacy impact

1. **Curl credentials could enter stored command evidence.** `src/commands/commandRecorder.ts:241` now handles `--oauth2-bearer` and `--pass` in separate and `=` forms through the existing curl-specific rule. Four synthetic credential regressions prove redaction; ordinary programs retain their arguments. Current curl help and [curl documentation](https://github.com/curl/curl/blob/master/docs/cmdline-opts/oauth2-bearer.md) confirm credential semantics; [long-option documentation](https://github.com/curl/curl/blob/master/docs/cmdline-opts/_OPTIONS.md) confirms equals syntax. This changes recorded metadata only, not executed arguments.

### Medium impact

2. **Doctor inspected storage after configuration denied access.** `src/doctor/doctor.ts:51` now requires successful configuration validation before session storage/recovery/capture checks. A real external directory with malformed state verifies denial and explicit opt-in; malformed configuration also stops storage inspection.
3. **Normal watcher shutdown could return before accepted writes completed.** `src/watcher/watcher.ts:66` always drains accepted events and loss markers after a close failure, stops new admissions, and preserves the original rejection. A deterministic deferred-write regression verifies ordering and that failed shutdown does not publish a completed report.
4. **Ancillary cleanup failure stranded session ownership.** `src/session/sessionManager.ts:611` removes the stop request before active state, retaining the primary lock until last. A real directory blocking stop-request deletion verifies ownership survives, repair permits recovery, and completed report bytes remain unchanged.
5. **Large valid analyses crashed during text rendering.** `src/analyze/render.ts:93` appends findings individually instead of spreading them as function arguments. A regression analyzes fifteen bounded files and renders all 150,000 findings in order without exposing synthetic credential values.

### Low impact

6. **Mixed-case package/lockfile names lost risk classifications.** `src/risks/riskDetector.ts:64` uses consistently lowercased tables and lookup. Tests cover canonical, uppercase, and lowercase Cargo, Pipfile, and Gemfile names while preserving original reported paths.

Existing public calls and stored session-report formats remain compatible; new diagnostics and CLI output modes are additive. Dependencies, configuration defaults, and coverage thresholds are unchanged. The initial audit regressions failed before their corresponding fixes. The complete source/test diff was reviewed; `git diff --check` passed.

## Follow-up work (2026-10-13)

Implemented the previously deferred work after revalidating the current tree:

- **Interrupted cleanup recovery:** a versioned, bounded, exclusively published session-local receipt precedes active-state removal. A dead surviving lock can resume cleanup only with matching complete ownership identity, contained regular storage, and a verified canonical completed report. Existing generation claims serialize competitors; only old session-local files are touched after releasing the primary lock. Missing, malformed, linked, mismatched, corrupt, or live-owner proof remains refused. Failure, concurrency, and replacement-session tests pass.
- **Wrapper-aware redaction:** explicit GNU `env` assignments/options and nested wrappers are parsed within 128 arguments/eight wrappers. Ambiguous syntax is redacted conservatively. Executed arguments remain unchanged. Redis `--pass` password inputs are also masked, including through `env`.
- **Bounded custom-pattern batching:** up to 64 independent line prefixes/65,536 code units per message, with unchanged worker deadlines, memory limits, and output bounds. Per-line matching order, all configured matches, allowlists, and failed-rule behavior are preserved.
- **Partial-scan visibility:** custom-pattern line truncation appears in text/JSON/SARIF, staged and needed baseline coverage, and recorded-session integrity warnings. `complete-review` and configured complete-coverage gates now reject partial scans. Built-in detectors still inspect the full retained line; no-pattern/ordinary response shapes remain unchanged.
- **Doctor JSON:** `doctor --json` exposes the existing structured checks and exit status. Successful repair emits one final JSON document; existing repair error behavior is preserved.
- **Atomic exports:** no-overwrite exports publish completed content with an exclusive hard link; interrupted writes leave no partial destination, and concurrent creators are preserved. Unsupported filesystems fail explicitly. Forced atomic replacement remains available.
- **Safe Markdown:** C1 controls and Unicode separators are visible escapes in reports and pull request comments; structured evidence retains exact values.

No dependencies, configuration defaults, coverage thresholds, or stored-report migrations were introduced. The full diff was reviewed. Test fixture watchers now close before removing their directories on assertion failure, preventing cleanup errors from hiding the original failure.

## Verification

| Check                                              | Final result                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm check`, Node.js 24.12.0 / Windows            | Passed format, lint, source/test types, both dead-code checks, build, coverage |
| Full suite, Node.js 24.12.0                        | 62 files passed; 825 tests passed, 9 existing skips                            |
| Full suite and coverage, Node.js 22.23.3 / Windows | 62 files passed; 825 tests passed, same 9 skips                                |
| `pnpm perf`                                        | Every existing and added budget passed                                         |
| `pnpm pack --dry-run`                              | Passed against the final rebuilt package                                       |
| Built CLI version and `doctor --json`              | Passed; valid JSON with `ok: true`                                             |
| Production/full dependency audits                  | Zero known advisories returned                                                 |
| Open CodeQL alerts                                 | Zero open alerts returned                                                      |
| `git diff --check`                                 | Passed                                                                         |

Both Node.js versions produced identical final coverage:

| Coverage   | Before follow-up | Final  |
| ---------- | ---------------- | ------ |
| Lines      | 92.84%           | 93.02% |
| Statements | 92.86%           | 92.98% |
| Functions  | 96.99%           | 97.32% |
| Branches   | 88.75%           | 89.13% |

The unchanged coverage exclusions remain CLI orchestration, the public barrel, and types; compiled end-to-end tests cover the CLI.

Final performance fixture: 25,000 lines, 25 expected findings; single-line custom matching **1,580 ms**, batched matching **42 ms**, complete analysis **153 ms**. Results/order matched exactly; no ratio-based or relaxed threshold was used.

The first Node.js 22 run used a Node.js 24 `node` on PATH for wrapped commands, exposing a test-environment mismatch and a cleanup-order issue. The corrected run verified both the main runtime and PATH child as 22.23.3 and passed the entire suite without weakening assertions or timeouts.

Evidence: initial logs/coverage under `.cache/audit/`; confirmed final checks, both runtime suites, performance, package contents, dependency/CodeQL snapshots, and Git probe under `.cache/audit-followup/`.

## Reliability completion (2026-10-13)

Base: `158f743ccd9c2af0d997c3d32d2d2d37bd79c96d`. The earlier audit and its hosted Windows/Linux/macOS Node.js 22/24 matrix and CodeQL checks passed before and after merging PR #74.

- Added bounded explicit `sudo`, `nohup`, `nice`, and `timeout` wrapper chains alongside `env`. Unknown options, shell modes, oversized prefixes, and excessive nesting redact conservatively; executed argv is unchanged. Docker/Podman now select the actual `login` subcommand after known global options, preserving ordinary port flags and masking attached password arguments.
- Expanded recorded assignment detection for `passphrase`, `pwd`, `credential(s)`, and cookie names, including escaped JSON. Negative identifier-boundary tests prevent the added names from creating avoidable entropy false positives. Watcherless exclusions and all resource bounds are unchanged.
- Added POSIX directory synchronization after atomic publication and temporary cleanup. Session locks and existing evidence logs are flushed; receipt/session-root entries precede active-state removal, shared state is synchronized before and after lock release, and old local cleanup follows. I/O, permission, and unsupported-sync failures remain explicit; complete published destinations are preserved when a later barrier fails.
- Fixed failed startup to retain the lock when active-state publication already succeeded or ownership is ambiguous. Recovery tests cover post-publication startup failure, cleanup barrier failures, log flush failure, concurrent ownership, and existing absent-log behavior.
- Made unsupported hard-link export errors actionable. Tested explicit atomic `--force` publication and replacement while hard links are rejected, preserving the default exclusive publication and competing-file protections.

Primary references: [Node FileHandle.sync](https://nodejs.org/docs/latest-v22.x/api/fs.html#filehandlesync), [sudo command grammar](https://github.com/sudo-project/sudo/blob/main/docs/sudo.man.in), [GNU command wrappers](https://www.gnu.org/software/coreutils/manual/html_node/Modified-command-invocation.html), [Docker options](https://docs.docker.com/reference/cli/docker/), and [Podman options](https://docs.podman.io/en/latest/markdown/podman.1.html).

The added wrapper/container regressions initially failed 25 cases; the assignment regressions initially failed all five new names. Targeted regressions passed after fixes. The initial full test run crossed source edits and retained earlier assignment matching while loading the new negative tests; it was not used as final evidence. A later lint check required preserving the cleanup error as the aggregate cause; that was corrected without weakening the rule. The complete check then ran against frozen source and passed.

| Final local check, Windows / Node.js 24.12.0 | Result                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| `pnpm check`                                 | Format, lint, source/test types, both dead-code checks, build and coverage passed |
| Full suite                                   | 63 files passed; 886 tests passed, 9 existing skips                               |
| Coverage                                     | Lines 93.16%; statements 93.08%; functions 97.33%; branches 89.31%                |
| `pnpm perf`                                  | All unchanged budgets passed                                                      |
| Final rebuilt package and `doctor --json`    | Passed                                                                            |
| Dependency audit                             | No known vulnerabilities returned                                                 |
| Source/staged diff checks                    | Passed                                                                            |

Evidence is under `.cache/audit-followup/`, notably `final-hardening-check-complete.log`, `final-hardening-perf-confirmed.log`, `final-hardening-package-confirmed.log`, and `final-hardening-dependencies.log`. Fresh hosted Windows/Linux/macOS Node.js 22/24 CI and CodeQL must pass before merging this update into protected `main`. Dependencies, coverage thresholds, configuration defaults, CLI contracts, and report formats remain unchanged.

## Decisions and remaining limits

- The previously blocked advisory and CodeQL checks are now verified; no dependency update was justified.
- The published baseline commit's Windows/Linux/macOS Node.js 22/24 CI matrix and CodeQL analysis passed. The audit changes were also tested locally on Windows with both runtimes. Fresh hosted CI and CodeQL must pass for the proposed commit before merging into the protected `main` branch. This audit does not tag or publish a release.
- A real Git textconv fixture did not invoke its converter for `--stat`, `--numstat`, `--name-status`, or `--raw`; the patch positive control did invoke it. No speculative Git change was made.
- Cleanup now includes POSIX directory barriers and file-content synchronization. Windows has no portable Node directory-entry flush, and filesystem/device behavior plus newly created ancestor directories prevent a universal power-loss guarantee. Missing proof remains preserved.
- Detection remains heuristic and storage/repository configuration remains trusted. The supported explicit wrappers and container command grammar were extended above; arbitrary shell programs and other wrappers remain outside the bounded parser. Configured custom rules and independent review remain the extension path for unknown/encoded credentials.
- Atomic no-overwrite exports require hard-link support/permission. Explicit `--force` atomic rename and stdout provide existing compatible alternatives; an automatic partial-copy fallback would violate complete publication and was not added.

- The temporary fixture from the initial mismatched-runtime run was successfully recovered with the final CLI. Its recursive removal was refused by the execution policy (`blocked by policy`), including after the exact path was verified. It remains at `C:/Users/bozdo/AppData/Local/Temp/abb-e2e-ekbsvl`, outside the project; final source/tests and package checks are unaffected.
