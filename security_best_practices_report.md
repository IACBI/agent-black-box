# Security Best Practices Report

## Executive Summary

The Agent Black Box TypeScript CLI was reviewed for local data exposure, path traversal, subprocess handling, state integrity, resource exhaustion, dependency risk, and CI supply-chain controls. No known critical or high-severity finding remains after the changes in this audit. The runtime remains local-first and does not require network access.

## Critical

No critical findings.

## High

No unresolved high-severity findings.

### SEC-001 — Repository escape through command working-directory links — Resolved

Impact: A repository-controlled symbolic link or junction could previously make `abb run --cwd` execute a command physically outside the repository.

`src/commands/commandRecorder.ts:80` now compares the real paths of the repository and requested directory. `src/utils/fileInspection.ts:20` also uses `lstat` so repository inspection does not follow symbolic links.

### SEC-002 — Partially written state and report files — Resolved

Impact: A crash during a direct write could leave corrupted state or expose a partial finalized report.

`src/utils/files.ts:27` writes through an exclusive same-directory temporary file, flushes it, and atomically renames it. Config, session JSON, and Markdown reports use this path; `session-metadata.json` remains the final completion marker.

## Medium

### SEC-003 — Incomplete command metadata redaction — Resolved

Nested environment assignments, authorization-like headers, URL credentials, and sensitive query parameters are redacted in `src/commands/commandRecorder.ts:111`. Spawn failures no longer persist command-derived error text.

### SEC-004 — Unbounded session finalization resources — Resolved

NDJSON input is streamed and bounded by line size, accepted record count, and warning count in `src/session/sessionManager.ts:31`. Git inspection and possible-secret scanning use deterministic bounded concurrency through `src/utils/concurrency.ts:1`.

### SEC-005 — Mutable GitHub Action references — Resolved

CI, CodeQL, and release workflows pin checkout, Node setup, CodeQL, and release attestation actions to verified release commit SHAs. Dependabot remains enabled for GitHub Actions maintenance.

## Low / Accepted Risk

### SEC-006 — Repository-external session directory — Resolved

Repository-controlled `sessionDir` values must remain physically inside the repository by default. `src/config/config.ts` rejects lexical traversal, existing symlink escapes, and UNC/network paths. A trusted local external location requires the explicit command-scoped `--allow-external-session-dir` override, which is never persisted back to configuration.

### SEC-007 — Dependency audit freshness — Resolved

Fresh production and development dependency audits completed successfully after registry connectivity was restored. CI and release workflows continue to gate production dependency advisories with `pnpm audit --prod --audit-level high`.

### SEC-008 — Unbounded JSON input — Resolved

Configuration, active state, catalog metadata, and session report JSON are read with explicit byte limits before parsing. Oversized files fail closed with a diagnostic instead of being loaded wholesale into memory.

### SEC-009 — Release artifact provenance — Resolved

The release workflow now creates a signed GitHub build-provenance attestation for each packaged tarball using short-lived OIDC credentials. Release consumers can verify the artifact with `gh attestation verify` in addition to checking `SHA256SUMS`.

## Validation Requirements

- `pnpm check` must pass.
- `pnpm perf` must remain within the documented time and memory budgets.
- CI must pass on Node.js 22 and 24 across Linux, Windows, and macOS.
- CodeQL and the production dependency audit must report no blocking result.
