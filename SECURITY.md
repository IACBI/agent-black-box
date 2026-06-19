# Security Policy

Agent Black Box is local-first and does not send repository data to external services.

## Supported Versions

Security fixes target the latest released version.

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
