# Security Policy

Agent Black Box is local-first and does not send repository data to external services.

## Supported Versions

Security fixes target the latest released version.

The supported runtime baseline is Node.js 22 or newer. End-of-life Node.js releases do not receive security support from this project.

## Reporting A Vulnerability

If the project is hosted on GitHub, please use GitHub Security Advisories when available. Otherwise, contact the maintainer privately before publishing exploit details.

Please include:

- A clear description of the issue.
- Steps to reproduce.
- Impact and affected versions, if known.
- Whether sensitive data, credentials, or repository contents could be exposed.

Do not include real secrets in reports. Use redacted values or clearly fake examples.

## Security Expectations

- Reports must not expose raw secret values.
- Command recording must not capture terminal output.
- Runtime behavior must not require telemetry or external APIs.
- Rollback behavior must not discard work without explicit user confirmation.
- Interactive rollback must exclude files whose pre-session state cannot be restored safely.
- Rollback apply must use literal Git pathspecs and must never apply a historical session to the current worktree.
- Command working directories must remain physically inside the repository, including through symbolic links and junctions.
- Repository inspection must not follow symbolic links to external content.
- State and finalized report writes must not expose partially written files as complete sessions.
- Production dependency audits and CodeQL analysis run in CI; runtime operation remains network-independent.

The latest repository-level review is recorded in [the project audit](docs/AUDIT.md).
