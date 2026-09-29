# Project audit

Baseline reviewed on 2026-09-27; follow-up updated on 2026-09-29.

## Scope and outcome

The baseline review covered the CLI, configuration, Git inspection, command capture, session lifecycle, evidence attribution, reports, exports, rollback, file watching, dependencies, tests, and CI/release configuration. The follow-up below records additional defects reproduced against 0.8.0 and their fixes for 0.8.1. Public exports and the full session JSON contract were preserved. No runtime dependency was added or removed.

This document consolidates the security review and completed professionalization plan. It records verified work and remaining limitations; it is not a guarantee that the project is free of vulnerabilities. See [Usage](USAGE.md) for commands, [Reports](REPORTS.md) for formats, and [Security policy](../SECURITY.md) for vulnerability reporting.

## Security and reliability changes

| Area                    | Implemented protection                                                                                                                                                                 | Regression coverage                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Command privacy         | Redact nested assignments, headers, credential-bearing URLs, sensitive JSON arguments, and labels without changing executed arguments. Spawn failures omit command-derived error text. | Command recorder tests                              |
| Command ownership       | Validate active repository, session location, and lock ownership before recording; honor the explicit external-storage override.                                                       | Command recorder and CLI tests                      |
| Filesystem containment  | Validate physical working directories and session storage; reject network storage and unsafe linked paths. Watch directory links without traversing their targets.                     | Configuration, inspection, and watcher tests        |
| Bounded reads           | Inspect regular files through one handle, limit bytes with an overflow probe, and check file identity around reads. Bound configuration, state, metadata, and report inputs.           | File utility and inspection tests                   |
| Atomic persistence      | Write state and reports through exclusive temporary files and atomic rename; write completion metadata last.                                                                           | File utility and session tests                      |
| Session finalization    | Coordinate live wrapped commands, preserve capture-loss warnings, and treat permission-denied process probes conservatively.                                                           | Session lifecycle and watcher tests                 |
| Rollback                | Use literal Git pathspecs; interactive apply requires the latest completed session and rechecks HEAD, index, path status, content, and the private safety snapshot.                    | Rollback, report, and CLI tests                     |
| Secret scanning         | Replace adversarial JWT backtracking with a linear component scan; use consistent Unicode code-point counts for entropy. Keep values redacted.                                         | Secret detector compatibility and adversarial tests |
| Windows batch execution | Preserve tested quoting and metacharacters; reject percent signs and line breaks. Replace trailing-backslash regex scanning with a linear backward scan.                               | Windows batch integration and quoting tests         |
| Supply chain            | Patch affected development dependencies, audit development and runtime packages in CI, pin workflow actions, and attest release artifacts.                                             | Dependency audit, CI, and release validation        |

## Performance and maintainability

- Untracked line counting uses one scan with constant auxiliary space instead of allocating a normalized string and line array.
- File inspection and secret scanning retain bounded concurrency. NDJSON ingestion limits record count, line size, and warning count.
- Compact catalog metadata and a bounded search index reduce full-report reads. Older reports retain a validated fallback.
- Reports above 32 MiB use verified replay metadata while retaining the full JSON report. Finalization refuses reports above 256 MiB and preserves raw logs.
- Reachability analysis, Knip, and TypeScript checks found no justified runtime dependency or public API removals. The watcherless analyzer and recorded-session detector retain their different contracts.

## Completed feature follow-up

- Staged analysis reads index blobs, compares against a fixed commit, and suppresses identical baseline secret-like lines up to their occurrence count. Git-verified rename sources and suppression counts appear in text, JSON, and SARIF.
- The new-secrets and complete-review policies provide explicit CI exit criteria, including skipped required content for complete review.
- History supports filters and interactive browsing. Retention previews protect active, incomplete, and corrupt sessions and require typed confirmation for deletion.
- Optional retention settings supply defaults. Archiving verifies copies with streaming checksums and a completion marker; originals remain in place.

## Remaining risks

| Priority | Limitation                                                                                                      | Recommended handling                                                                                                                       |
| -------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Medium   | Reports above 256 MiB cannot be finalized. Even bounded legacy parsing can consume substantial memory.          | Preserve raw logs. Introduce streaming or paged APIs only when a real workload justifies changing readers and all report writers together. |
| Medium   | A hostile local process with the same filesystem access can race path checks and subsequent operations.         | Treat repository and session storage as locally trusted. Preflight checks reduce accidental races but are not an atomic security boundary. |
| Medium   | Two CodeQL findings remain open for dynamic command construction in the Windows batch fallback.                 | See the command review below. Keep the findings visible and independently review Windows quoting before claiming they are false positives. |
| Low      | Command redaction and secret detection are heuristic. Free-form syntax and false negatives remain possible.     | Review reports and archives before sharing. Findings are not proof of a vulnerability; absence of findings is not proof of safety.         |
| Low      | Batch scripts may reinterpret arguments internally. Manual rollback snippets use POSIX shell syntax.            | Prefer native executables for arbitrary arguments and use a compatible shell for manual snippets.                                          |
| Low      | The exported applyRollbackPlan helper retains its existing API and does not perform the CLI snapshot preflight. | Callers must enforce appropriate validation before invoking it.                                                                            |

Interrupted pruning may leave a hidden .pruning-* directory. Interrupted archiving may leave a destination without .abb-archive-complete.json. Inspect these before manual cleanup; neither should be assumed disposable solely from its name.

## Validation evidence

The implementation baseline at commit 690353f was validated on Windows with Node.js 24.12.0 and pnpm 10.30.3:

- Formatting, ESLint, TypeScript, both dead-code checks, production build, and coverage thresholds passed.
- 27 test files passed: 153 tests passed and one Windows file-symlink test was skipped. Coverage was 86.65% statements, 79.85% branches, 92.35% functions, and 86.35% lines.
- The dependency audit reported no known advisories across 279 dependencies at the time of the check. Package dry run, release metadata validation, and performance budgets passed.
- A real terminal run verified history pagination, summary opening, and exit.
- [PR #50](https://github.com/IACBI/agent-black-box/pull/50) passed all 12 hosted checks at that baseline, including CodeQL and Node.js 22/24 on Linux, macOS, and Windows, and was merged.

These results describe that revision and date. They do not establish the status of later changes or future dependency advisories. Performance checks are regression budgets, not cross-platform latency guarantees.

## Dependency review for 0.8.0

Prettier 3.9.9 and typescript-eslint 8.71.0 are compatible updates. Node.js type definitions now target Node 22, the project's minimum supported runtime, instead of Node 20. The CodeQL Action steps were updated together to v4.38.2 because mixing versions made individual Dependabot PRs fail.

Major upgrades remain separate work: Commander 15 and Vitest 5 require at least Node 22.12 while the package currently promises Node 22 generally. TypeScript 7 is outside typescript-eslint 8.71.0's declared peer range. Vitest 5 and its coverage package must move together. Chokidar 5 and simple-git 4 need focused watcher and Git compatibility testing before changing runtime dependencies. Using Node 26 type definitions would allow APIs newer than the supported runtime baseline.

The 0.8.0 release preflight passed on Windows with Node.js 24.12.0 and pnpm 10.30.3: formatting, lint, type checks, dead-code checks, build, 153 tests (one Windows file-symlink test skipped), package dry run, production audit, and release metadata validation. Coverage was 86.65% statements, 79.85% branches, 92.35% functions, and 86.35% lines. A full dependency audit found no known advisories across 286 packages, and the large-session performance budgets passed. These results describe the local preflight; hosted CI and release artifacts must be verified separately.

## Security and reliability follow-up for 0.8.1

| ID     | Priority | Reproduced issue                                                                                                 | Change and regression evidence                                                                                                        |
| ------ | -------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| ABB-01 | Medium   | Assignment scanning retried whitespace prefixes, causing quadratic work on long padded lines.                    | Start at key boundaries. Two 256 KiB adversarial inputs are checked by the performance budget.                                        |
| ABB-02 | Medium   | A benign or environment-based assignment could hide a later credential-like assignment on one line.              | Inspect every supported assignment while retaining one secret finding per line. Tests cover code, compact JSON, and environment use.  |
| ABB-03 | Medium   | Stop requests could be sent when active state and lock ownership did not match.                                  | Validate recovery state before writing a request. End-to-end tests reject mismatched owners and corrupt state without altering them.  |
| ABB-04 | Medium   | Completion metadata could trigger stale-state cleanup when the completed report was missing or corrupt.          | Verify the completed report first. Tests preserve invalid state and verify cleanup for a valid report.                                |
| ABB-05 | Medium   | Repeated timestamps could reuse a session directory and truncate its original event logs.                        | Add a random ID suffix and create directories exclusively. A fixed-clock test verifies distinct IDs and preserved original evidence.  |
| ABB-06 | Medium   | A Markdown report replaced by a symbolic link could stream a file outside the selected session.                  | Reject non-regular files and compare identity with the opened handle. A POSIX end-to-end test checks refusal and target preservation. |
| ABB-07 | Low      | SARIF emitted duplicate identical rule descriptors and unencoded file URI components.                            | Share descriptors and encode URI components. An end-to-end test retains both findings for a path containing spaces, `#`, and `%`.     |
| ABB-08 | Low      | A backwards system-clock adjustment created a negative command duration, causing a valid record to be discarded. | Use a monotonic duration while preserving wall-clock timestamps. A regression test moves system time backwards during a real command. |

The SARIF changes follow the [OASIS SARIF 2.1.0 specification](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html): rule descriptor objects must be unique and file locations must be valid URI references.

### Follow-up validation

The 0.8.1 preflight passed locally on Windows with Node.js 24.12.0 and pnpm 10.30.3:

- Formatting, ESLint, TypeScript, reachability analysis, Knip, production build, production dependency audit, package dry run, and release metadata validation passed.
- All 27 test files passed: 162 tests passed and two file-symlink tests were skipped on Windows. Coverage was 87.10% statements, 80.72% branches, 92.73% functions, and 86.81% lines.
- A full dependency audit found no known advisories across 286 packages on 2026-09-29.
- Performance budgets passed: 100,000 NDJSON events took 149 ms with a 5.4 MiB measured heap delta; two adversarial 256 KiB analyzer inputs took 2 ms. Report generation, legacy catalog fallback, and large-repository analysis also stayed within their budgets.

These measurements describe this local run. Hosted checks verify the supported operating systems and Node.js versions separately, including the POSIX linked-report regression.

### Open CodeQL findings

After the 0.8.1 release, the repository alert API still reported [alert #4](https://github.com/IACBI/agent-black-box/security/code-scanning/4) (`js/shell-command-constructed-from-input`) and [alert #5](https://github.com/IACBI/agent-black-box/security/code-scanning/5) (`js/shell-command-injection-from-environment`) at medium severity. A successful CodeQL workflow means analysis completed; it does not mean no alerts exist.

Both findings point to `src/commands/commandRecorder.ts`. Native executables receive an argument array with `shell: false`. Windows `.cmd` and `.bat` files use a `cmd.exe /d /v:off /s /c` wrapper: AutoRun commands and delayed environment expansion are disabled, as described in the [Microsoft command reference](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd). The wrapper rejects percent signs, line breaks, and null characters before execution and quotes argument values. Alert #5's displayed environment sources include test calls using `process.execPath`; those calls normally take the native executable branch.

The Windows integration fixture was expanded with empty arguments, embedded quotes, parentheses, tabs, caret/pipe/redirection characters, and attempted injected commands. All values arrived unchanged and the injection marker was absent. A second integration test verifies native execution through a path containing spaces, `&`, and parentheses, with argument values preserved. All 18 command-recorder tests passed locally on Windows. These tests establish the checked cases, not correctness for every Windows parser combination or for how an arbitrary batch script reinterprets its arguments.

The alerts remain open. No queries were excluded, findings suppressed, or runtime behavior rewritten merely to make the scanner quiet. An independent review of Windows quoting is still recommended. CodeQL's [library-input query guidance](https://codeql.github.com/codeql-query-help/javascript/js-shell-command-constructed-from-input/) and [environment-input query guidance](https://codeql.github.com/codeql-query-help/javascript/js-shell-command-injection-from-environment/) explain the underlying risk; a generic POSIX quoting library would not establish Windows safety.

The exported `recordAndRunCommand` function executes the caller's selected executable and arguments. Programmatic callers must authorize that command before invoking it; recording and redaction do not provide a command sandbox.

### Completed detector source review

The local access restriction was resolved on 2026-09-29. The follow-up source review now includes `src/risks/secretDetector.ts` and `tests/secretDetector.test.ts`, their callers, bounded file inspection, and concurrency handling. The review checked byte limits, line numbering, redacted finding contents, deduplication, JWT compatibility, Unicode entropy, and physical repository containment. No additional runtime defect was identified in these modules.

A direct detector integration regression now verifies that changed files reached through a directory link outside the repository produce no findings. It uses a Windows junction or a POSIX directory symlink and complements the existing file-inspection test, protecting the detector's trusted-root wiring. Existing detection rules and public API contracts remain unchanged. Heuristic detection limits and the open CodeQL findings above remain applicable.

The completion preflight passed on Windows with Node.js 24.12.0 and pnpm 10.30.3: `pnpm release:check`, `pnpm perf`, and a full dependency audit. All 27 test files passed with 164 tests passed and two file-symlink tests skipped on Windows; coverage remained 87.10% statements, 80.72% branches, 92.73% functions, and 86.81% lines. Both dead-code checks passed and no known dependency advisories were reported. The performance run read 100,000 events in 174 ms with a measured heap delta of 9.2 MiB; all other budgets passed. These are local measurements and do not establish a peak-memory or cross-platform latency guarantee.

## Recommended next work

1. Build shared behavioral fixtures for watcherless and recorded-session findings before considering detector consolidation.
2. Add local review policies for dependency and configuration changes using the existing analysis and SARIF architecture.
3. Revisit large-report storage only with representative sessions approaching the current limit; the inspected local reports were approximately 0.02 MiB or smaller.
