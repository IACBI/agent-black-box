# Agent Black Box

Agent Black Box is a local-first CLI tool that records and explains observable repository changes during AI-assisted coding sessions.

It is designed for developers who want a clear audit trail of what changed while using tools such as Codex, Claude Code, Cursor, Cline, or similar coding agents. The MVP does not integrate with those tools directly and does not inspect private agent reasoning. It records repository-level evidence: file events, Git status, diff summaries, risky file changes, possible secret-like values, and rollback hints.

## Why it exists

AI coding agents can make broad edits quickly. Agent Black Box gives developers a Git-friendly local record that helps answer practical review questions:

- What files changed during the session?
- Which changes look risky and deserve careful review?
- Were possible secrets introduced?
- What safe manual rollback commands should be considered?

## What it can and cannot observe

Agent Black Box can observe file changes and Git repository state while it is running. It can generate cautious reports from that observable evidence.

Agent Black Box cannot see an AI agent's hidden reasoning, prompts, model internals, browser state, editor state, or command history unless those details are reflected in repository changes. Command capture is not implemented in this MVP, so reports include explicit placeholders.

## Installation from source

```sh
pnpm install
pnpm build
```

Run the CLI during development:

```sh
pnpm dev -- --help
```

After building, the binary entry is:

```sh
node dist/cli.js --help
```

## CLI usage

```sh
abb init
abb start
abb stop
abb status
abb report
abb timeline
abb risks
abb rollback
```

During development, replace `abb` with `pnpm dev --`:

```sh
pnpm dev -- init
pnpm dev -- start
pnpm dev -- stop
```

## Example workflow

1. Initialize config:

   ```sh
   pnpm dev -- init
   ```

2. Start a foreground recording session:

   ```sh
   pnpm dev -- start
   ```

3. Make changes with your editor or coding agent.

4. From another terminal, stop the session:

   ```sh
   pnpm dev -- stop
   ```

5. Review reports:

   ```sh
   pnpm dev -- timeline
   pnpm dev -- risks
   pnpm dev -- rollback
   ```

## Generated reports

Reports are written under `.agent-black-box/sessions/<session-id>/`:

- `session.json`: structured session metadata, events, Git snapshot, risks, and possible secrets.
- `timeline.md`: chronological file events and changed files.
- `diff-summary.md`: Git status, diff summary, changed files, and notable categories.
- `risks.md`: risky files changed, possible secrets, dependency/config changes, CI/CD changes, and a review checklist.
- `rollback.md`: manual rollback hints and review commands.

## Privacy model

- Local-first by design.
- No external API calls are required.
- No telemetry is included.
- Reports are stored in the local repository under `.agent-black-box/`.
- Possible secret values are redacted in reports.

## Project health

- CI runs typecheck, build, and tests on GitHub Actions.
- Dependency updates are tracked with Dependabot.
- Security reporting guidance is documented in `SECURITY.md`.
- Contributions are documented in `CONTRIBUTING.md`.

## Limitations

- No direct Codex, Claude Code, Cursor, or Cline integration is implemented.
- Command capture is not implemented.
- Risk and secret detection are heuristics and may produce false positives or miss real issues.
- Rollback is advisory only; Agent Black Box does not automatically revert changes.
- Git diff line counts may not include untracked files until they are staged or otherwise tracked by Git.

## Roadmap

- Optional command capture through explicit wrappers or shell integration.
- Richer diff analysis for untracked files.
- Safer interactive rollback workflows with confirmation.
- Editor integrations.
- Web dashboard.

## Contributing

Contributions are welcome. Keep changes focused, tested, local-first, and respectful of private repositories. Avoid telemetry and external service dependencies unless they are optional and clearly documented.

Maintainer: 𝓐.𝓒.𝓑

## License

MIT
