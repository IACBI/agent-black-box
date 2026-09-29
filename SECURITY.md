# Security Policy

Security fixes target the latest released version. The supported runtime is Node.js 22 or newer, as declared in `package.json`.

## Report a vulnerability

Report privately through the [GitHub Security page](https://github.com/IACBI/agent-black-box/security) when available. Otherwise, use an existing private maintainer contact channel before publishing exploit details.

Include affected versions, reproduction steps, impact, and possible data exposure. Use redacted or synthetic examples; never include real credentials or private repository contents.

## Privacy and trust

Evidence stays local: Agent Black Box has no telemetry and does not upload repository data or capture terminal output. Redaction is heuristic; review reports before sharing. Repository and session storage must be trusted: processes with the same filesystem access can race checks or alter evidence.

`abb run` and `recordAndRunCommand` execute selected commands with their existing permissions. Programmatic callers must authorize executable names and arguments; recording is not a sandbox. Native executables run without a shell. On Windows, `.cmd`/`.bat` scripts run through `cmd.exe` with quoted arguments; percent signs, line breaks, and NUL are rejected, and regression tests cover injection payloads. Bare script names resolve only through absolute PATH entries, never from the repository, and tests verify that a planted `git.exe` is not executed.

`applyRollbackPlan` bypasses the CLI's snapshot preflight. Callers must validate and obtain appropriate confirmation before restoring files.

See [Usage](docs/USAGE.md) for safe workflows and [Architecture](docs/ARCHITECTURE.md) for trust boundaries.
