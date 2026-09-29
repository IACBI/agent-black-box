# Project audit

Reviewed **2026-09-30** from clean `main` revision `91624bf` (0.8.1): source/tests, configuration, dependencies and workflows. Fixes preserve interfaces, report fields, rules and runtime dependencies. See [Usage](USAGE.md), [Reports](REPORTS.md), [Security](../SECURITY.md) and released [history](../CHANGELOG.md).

## Reproduced fixes

Priority: M = medium, L = low. Each change has regression coverage.

| ID     | Priority | Fix                                                                                      |
| ------ | -------- | ---------------------------------------------------------------------------------------- |
| AUD-01 | M        | Clean in-flight markers and sanitize synchronous command-start failures.                 |
| AUD-02 | M        | Treat ENOENT/ENOTDIR disappearance as missing; propagate permission errors.              |
| AUD-03 | M        | Enforce staged/baseline blob byte bounds; overflow cannot appear complete.               |
| AUD-04 | M        | Reject same-size log corruption before pruning with full record/digest validation.       |
| AUD-05 | M        | Use exclusive hard-link publication against concurrent config replacement.               |
| AUD-06 | M        | Publish forced exports atomically; retain old files on failure and protect link targets. |
| AUD-07 | M        | Use exact NUL-delimited unstaged numstat for counts and rename destinations.             |
| AUD-08 | L        | Detect non-directory session roots/ancestors during storage diagnostics.                 |
| AUD-09 | L        | Require string report enums/Git identities; preserve legacy normalization.               |

See [source](https://github.com/IACBI/agent-black-box/tree/main/src), [session storage](https://github.com/IACBI/agent-black-box/tree/main/src/session) and [regressions](https://github.com/IACBI/agent-black-box/tree/main/tests). Reachability/Knip justified no source/dependency removals.

The recorded-session detector and its tests were reviewed from supplied copies. No production defect or rule change was warranted. Two regressions cover sensitive-keyword requirements, redaction and deduplication across overlapping rules, lines and duplicate paths. Recorded-session and watcherless/staged heuristics remain separate; parity is not guaranteed.

## Verified local evidence

Windows, Node.js 24.12.0, pnpm 10.30.3. `pnpm release:check` passed formatting, lint/types, dead-code checks, build/coverage, production audit, package dry run and version validation. Documentation links, anchors and package inclusion are also checked.

- 27 test files: **199 passed, four skipped** (three file-symlink cases, one tab-filename case on Windows).
- Coverage: 87.77% statements, 81.83% branches, 92.93% functions, 87.51% lines.
- Full development/production dependency audit: no known vulnerabilities on 2026-09-30.
- `pnpm perf` passed: 100,000 events in 205 ms/22.3 MiB measured heap delta; adversarial inputs in 2 ms. These budgets are not peak-memory/cross-platform guarantees.

Hosted CI covers Node.js 22/24 on Linux, Windows and macOS, including POSIX regressions unavailable in this local run. Green CodeQL does not mean zero alerts.

## Remaining limits and next work

- [CodeQL #4](https://github.com/IACBI/agent-black-box/security/code-scanning/4) and [#5](https://github.com/IACBI/agent-black-box/security/code-scanning/5) were open at medium severity on 2026-09-30 for Windows command construction. No findings were suppressed; independent parser review is recommended.
- Bare `.bat`-only Windows commands can fail in the `.cmd` fallback. Use explicit `.bat` paths; fix PATH/PATHEXT without retrying failed scripts.
- Structured counts remain unstaged counts. Define staged/worktree/net semantics before extending statistics/scoring.
- Init requires hard-link support and fails safely without it. Windows pending-deletion EPERM remains a visible permission error.
- Pruning adds bounded parsing time/memory; other readers use lighter verification. Reports above 256 MiB cannot finalize; raw logs remain.
- Same-user path races remain. Preserve interrupted quarantine/archive evidence. Detection/redaction are heuristic; review shared artifacts. Library helpers need caller authorization/validation.

Next: Windows script selection, line-count semantics and pruning benchmarks; a read-only integrity command is compatible future work. Publication uses [Node.js filesystem semantics](https://nodejs.org/docs/latest-v22.x/api/fs.html), consulted through Context7.
