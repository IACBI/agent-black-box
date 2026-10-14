# Audit and hardening status

Updated: 2026-10-14. Baseline: `821c0041066ca127ae16035c09b21a0c704d540d` (0.8.4). This report consolidates the audit and follow-up work; behavior and operational limits are maintained in [Usage](docs/USAGE.md), [Architecture](docs/ARCHITECTURE.md), [Reports](docs/REPORTS.md), and [Evidence security](docs/EVIDENCE-SECURITY.md).

The lead inspected the repository, CLI/reports/build configuration, established a clean baseline, and coordinated three independent scopes: capture/security, analysis/Git/rollback, and session storage. Findings required source evidence and failing regressions before implementation. Cross-scope peer review and final integration remained centralized. The previous uncommitted fixes were preserved throughout follow-up work.

## Verified improvements

All implemented findings had high confidence. Changes favor privacy, policy correctness, evidence preservation, and bounded resource use without changing existing report formats or weakening checks.

1. **High: overlapping credential rules exposed fragments.** `src/risks/secretPatternEvaluator.ts:10` and `src/commands/commandRecorder.ts:553` now combine configured, built-in, and embedded-script matches on original input through a bounded endpoint mask. Transitive overlaps, partial provider prefixes, named groups, lookaround, Unicode, adjacent matches, structural URL/JSON/assignment/flag transformations, and fail-closed limits are covered. Unmatched custom rules retain previous formatting; executed arguments remain untouched.
2. **High: inherited Git modes could bypass staged review.** `src/git/executable.ts:7` removes four ambient pathspec-mode overrides. Literal mode previously omitted staged changes; case-insensitive mode broke baseline tree inspection. Real Git tests protect exclusions, alternate indexes, literal paths, existing-secret suppression, and new-secret policy failure. [Git documents these environment semantics](https://github.com/git/htmldocs/blob/gh-pages/git.adoc).
3. **High: POSIX filename collisions could hide findings.** `src/analyze/analyzer.ts:184` preserves literal backslashes on POSIX while retaining Windows separator normalization and strict unsafe-path validation. Semantic tests cover both platforms; actual POSIX worktree/staged fixtures verify distinct findings and correct baseline suppression in hosted Linux/macOS runs.
4. **High integrity: displaced session storage received writes/deletions.** `src/session/sessionManager.ts:711`, `:728`, and `:1018` require a regular session child at its expected physical location, recheck before publication, and preserve uncertain claims rather than unlinking through a replacement alias. Deterministic tests cover displacement before recovery and during paused reads, preserving unrelated target files, moved evidence, and active/lock bytes. Trusted repository/storage aliases remain compatible.
5. **Medium: capture arrays could exceed the report policy before its guard ran.** `src/session/sessionManager.ts:487` and `src/session/ndjson.ts:73` reserve accepted canonical UTF-8 record bytes before retention, sharing 256 MiB across both logs. Unknown fields count; malformed records retain diagnostics. Started readers drain before claims can be released. Exact-boundary, one-byte-over, UTF-8, unknown-field, and paused-reader failure tests protect this behavior.
6. **Medium: recovery could wait indefinitely for live marker PIDs.** `src/session/sessionManager.ts:599` adds an optional monotonic live-wrapper deadline. `recover --command-wait-timeout-ms` and `--max-record-bytes` expose bounded recovery controls. Default waiting stays unlimited. Invalid options fail before mutation; refusal preserves markers/logs/ownership, and normal retries complete after the cause is removed.
7. **Medium: concurrent hook creation was overwritten.** `src/hooks/preCommitHook.ts:122` exclusively publishes an absent hook through the existing atomic helper. A competing foreign hook remains byte-for-byte intact. Managed/forced replacement and backups retain their existing behavior.
8. **Medium: rejected linked archive paths modified storage.** `src/session/sessionRetention.ts:444` resolves physical ancestry before creating directories and retains post-creation checks. Ordinary/resumed archive regressions preserve source bytes and create no rejected nested directories.
9. **Medium: dense valid scans overflowed the argument stack.** `src/analyze/analyzer.ts:166` appends findings individually. A 250,000-byte input retains all 125,000 findings in order with the expected summary.

Existing call signatures remain compatible; optional finalization settings and internal composition helpers are additive. Dependencies, lockfile, stored formats, configuration defaults, runtime support, and coverage thresholds are unchanged. No speculative dependency deletion, migration, or upgrade was justified by either dead-code check.

## Verification

Local final verification used Windows, Node.js 24.12.0, Git 2.52.0, and pnpm 10.30.3 against frozen source.

| Check                                          | Baseline                              | Final                                                                                    |
| ---------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm check`                                   | Passed                                | Passed formatting, ESLint, source/test types, both dead-code checks, build, and coverage |
| Full suite                                     | 63 files; 886 passed, 9 skipped       | 63 files; 939 passed, 11 platform skips                                                  |
| Lines                                          | 93.16% (4,266/4,579)                  | 93.27% (4,340/4,653)                                                                     |
| Statements                                     | 93.08%                                | 93.14%                                                                                   |
| Functions                                      | 97.33%                                | 97.36%                                                                                   |
| Branches                                       | 89.31%                                | 89.31%                                                                                   |
| `pnpm perf`                                    | All budgets passed                    | All unchanged budgets and new meaningful scenarios passed                                |
| Production/full dependency audits              | Initial registry access blocked       | Both returned no known vulnerabilities                                                   |
| `pnpm pack --dry-run`, `pnpm release:validate` | Passed                                | Passed                                                                                   |
| Built CLI version/help/doctor                  | Initial sandbox ownership restriction | Correct version, recovery help, and valid doctor JSON with `ok: true`                    |
| Complete diff and whitespace                   | Clean starting tree                   | Reviewed; `git diff --check` passed                                                      |

There were no pre-existing quality-gate failures or regressions in previously passing tests. Fifty-five test cases were added, including two actual POSIX fixtures skipped locally on Windows. Those run on Linux/macOS; semantic tests exercise both path conventions locally. New regressions were observed failing before their corresponding fixes. No checks were weakened and no artificial coverage-only tests were added.

The final performance run retained 100,000 records with exact byte accounting in 270 ms and composed 1,000 command redactions in 294 ms, each within the existing 5,000 ms budget. Other existing report, analysis, streaming, and timeline budgets passed. These are regression budgets, not cross-platform latency or peak-RSS guarantees.

CLI, usage, security/resource limits, architecture, report contracts, bilingual README, contributor guidance, and Unreleased notes were updated together. CLI/documentation contract tests passed. Stale audit logs, temporary synthetic repositories, and duplicate historical audit notes were removed; the current build/coverage outputs and latest ignored `.cache/hardening-verification/` evidence remain useful development artifacts.

## Integration and remaining limits

The protected `main` branch requires fresh `Analyze` (CodeQL) and `Required checks` for the submitted head. Changes use a normal review branch and PR merge without administrator bypass, force push, or weakened protection. Open CodeQL alerts were empty when inspected; a successful analysis alone is not proof that no alerts exist. The original hardening pass did not tag or publish a release; the 0.9.0 follow-up below prepares those changes for distribution.

- Local storage and repository configuration remain trusted. Portable path checks reduce verified displacement failures but cannot provide an atomic guarantee against hostile concurrent directory swaps. Broader managed/forced hook mutation races require a separate locking/identity design.
- Displaced storage retains its uncertain finalization claim. Restore trusted storage and let the failed finalizer exit before retrying; ordinary quota/deadline failures retain their safe retry behavior.
- Accepted-record quotas exclude parsed objects, arrays, stream buffers, Git data, and report metadata/formatting. Finalization still materializes accepted records, and the existing final-report limit can reject a report after record admission. This is not a heap/RSS cap.
- The wait option bounds only the live-wrapper phase, not total recovery time or OS scheduling. Omitted, waiting remains unlimited for compatibility.
- Credential recognition remains heuristic for unknown, encoded, split, or obfuscated inputs; signed evidence requires an independently trusted key. Inline-report verification keeps its documented self-contained semantics.

## 0.9.0 release and governance follow-up

The optional combined record-count quota in `FinalizeSessionOptions.maxRecords` and `recover --max-records` complements canonical byte limits for many-small-record workloads. Validation precedes mutation; both log readers share the counter before retention. Malformed lines do not count. Cross-log overflow preserves raw logs and active/lock ownership, releases its settled claim, and allows an exact-boundary retry. Two focused tests failed before implementation. Five additional cases cover count overflow/retry and invalid CLI inputs; existing byte and command-wait behavior remains covered. There are no dependency, lockfile, default-limit, or stored-format changes.

Local `RELEASE_TAG=v0.9.0 pnpm release:check` passed all quality gates, the production audit, packaging, and release metadata validation: 63 files, 944 passed, 11 platform skips. Lines are 93.28% (4,346/4,659), statements 93.15%, functions 97.36%, and branches 89.33%; the preceding hardening results above were 93.27%, 93.14%, 97.36%, and 89.31%. Performance budgets passed. A real Git fixture exercised the exact release-source shell block: current main was accepted and an unmerged commit was refused. The tag guard runs before dependency installation or publication.

GitHub now requires pull requests, dismisses stale approvals, preserves strict/admin/conversation protections, and binds both required checks to GitHub Actions app 15368. The repository has one write-capable maintainer, so independent approval remains explicitly optional; requiring it would prevent the author from merging. CONTRIBUTING documents enabling independent approval when a second trusted maintainer joins. CODEOWNERS, a PR checklist, structured bug/feature forms, and private vulnerability routing support review without soliciting sensitive reports. The active `Protect release tags` ruleset blocks updates/deletion of existing `v*` tags and has no bypass actors; release assets themselves are not made immutable by this rule.

Usage, architecture, security guidance, changelog, package, and CLI version are aligned for 0.9.0. Operational guidance covers paired count/byte quotas, trusted storage, serial hook maintenance, backups, OS isolation/resource limits, independent keys, complete-coverage gates, and layered secret scanning. These precautions reduce exposure; atomic hostile filesystem safety, hard heap/RSS bounds, and complete credential recognition remain outside the guarantees. Publish through a normal checked PR and a tag on the verified current protected main commit.
