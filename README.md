# Agent Black Box

[![CI](https://github.com/IACBI/agent-black-box/actions/workflows/ci.yml/badge.svg)](https://github.com/IACBI/agent-black-box/actions/workflows/ci.yml)
[![CodeQL](https://github.com/IACBI/agent-black-box/actions/workflows/codeql.yml/badge.svg)](https://github.com/IACBI/agent-black-box/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Agent Black Box is a local-first CLI for recording and explaining observable repository changes during AI-assisted coding sessions.

It helps developers review what changed while using tools such as Codex, Claude Code, Cursor, Cline, and similar coding agents. It does not integrate with those tools directly, inspect hidden reasoning, or send repository data anywhere. It records evidence from the repository: file events, Git status, diffs, opt-in command metadata, risky file changes, possible secret-like values, and rollback hints.

## Why Use It

AI coding agents can move quickly. Agent Black Box gives you a calm audit trail before you commit:

- See which files changed during a session.
- Review risky areas such as env files, CI/CD, dependencies, auth, security, migrations, and config.
- Detect possible secret-like values with redacted reporting.
- Record commands you explicitly run through `abb run`.
- Generate Markdown and JSON reports that are safe to keep beside Git workflows.
- Get rollback suggestions without automatically discarding work.

## Quick Start

```sh
pnpm install
pnpm build
pnpm dev -- init
```

Start a recording session:

```sh
pnpm dev -- start
```

In another terminal, run commands through Agent Black Box when you want command metadata recorded:

```sh
pnpm dev -- run -- pnpm test
```

Stop and generate reports:

```sh
pnpm dev -- stop
pnpm dev -- summary
pnpm dev -- timeline
pnpm dev -- risks
pnpm dev -- rollback
```

Reports are written to:

```text
.agent-black-box/sessions/<session-id>/
```

## CLI Commands

| Command | Purpose |
| --- | --- |
| `abb init` | Create `.agentblackbox.json`. |
| `abb start` | Start a foreground recording session in the current Git repository. |
| `abb doctor` | Check local prerequisites, repository state, config, and session health. |
| `abb run -- <command>` | Run a command and record redacted command metadata for the active session. |
| `abb stop` | Stop the active session and generate reports. |
| `abb status` | Show whether a session is active, stale, or absent. |
| `abb report` | Print the latest `session.json`. |
| `abb summary` | Print the latest human-readable session summary. |
| `abb commands` | Print commands recorded in the latest session. |
| `abb timeline` | Print the latest chronological timeline. |
| `abb risks` | Print risky changes and possible secret findings. |
| `abb rollback` | Print safe manual rollback suggestions. |

Detailed usage: [docs/USAGE.md](docs/USAGE.md)

## What Gets Generated

Each session produces:

- `session.json`: structured metadata, events, commands, Git snapshot, risks, and possible secrets.
- `summary.md`: concise review-first session summary.
- `commands.md`: command metadata recorded through `abb run`.
- `timeline.md`: chronological file and command timeline.
- `diff-summary.md`: Git status, changed files, line counts where available, and notable categories.
- `risks.md`: risky files, possible secrets, dependency/config changes, CI/CD changes, and review checklist.
- `rollback.md`: manual review and rollback suggestions.

Report details: [docs/REPORTS.md](docs/REPORTS.md)

## Privacy And Safety Model

Agent Black Box is designed for private repositories:

- Local-first by default.
- No telemetry.
- No external AI API.
- No repository upload.
- No terminal output capture.
- Possible secret values are redacted in reports.
- Rollback is advisory only and never automatic.

Command capture is opt-in. Only commands run through `abb run -- <command>` are recorded, and sensitive-looking arguments are redacted before they are written.

## What It Cannot Observe

Agent Black Box reports observable evidence only. It cannot see:

- An AI agent's hidden reasoning.
- Prompts or private model state.
- Editor state.
- Browser state.
- Shell history for commands not run through `abb run`.
- Why a change happened.

Reports intentionally use cautious language such as "possible", "likely", and "detected from repository changes".

## Project Quality

- TypeScript strict mode.
- Vitest test coverage for core behavior.
- GitHub Actions CI for typecheck, build, and tests.
- CodeQL analysis.
- Dependabot for patch/minor maintenance.
- Tag-driven release workflow.
- MIT license.
- Security reporting guide.
- Contribution guide.

Architecture notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Development

```sh
pnpm install
pnpm check
```

Run the CLI locally:

```sh
pnpm dev -- --help
```

After building:

```sh
node dist/cli.js --help
```

## Roadmap

Near-term improvements:

- Better command grouping in reports.
- Optional interactive report summary.
- Stronger binary file detection.
- More precise diff stats for untracked files.
- Confirmed interactive rollback flow.

Out of scope for the MVP:

- Web dashboard.
- VS Code extension.
- Cloud sync.
- Private agent API integrations.
- Automatic destructive rollback.
- Paid AI features.

## Maintainer

𝓐.𝓒.𝓑

## License

MIT. See [LICENSE](LICENSE).
