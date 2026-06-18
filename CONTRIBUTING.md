# Contributing

Thanks for helping improve Agent Black Box. The project is intentionally local-first, privacy-conscious, and conservative about behavior that could affect user repositories.

## Local Setup

```sh
pnpm install
pnpm check
```

`pnpm check` runs typecheck, build, and tests.

## Development Workflow

1. Keep changes focused and easy to review.
2. Update tests when behavior changes.
3. Update docs when user-facing behavior changes.
4. Keep reports based on observable repository evidence.
5. Use cautious language for heuristic findings.

## Design Principles

- No telemetry.
- No required external services at runtime.
- No hidden network calls.
- No automatic destructive rollback.
- No raw secret values in reports.
- No claims of direct AI-agent integration unless implemented.

## Pull Request Checklist

- `pnpm check` passes locally.
- New behavior has focused tests.
- README or `docs/` pages are updated when needed.
- Security-sensitive behavior has been reviewed for secret exposure.
- Rollback behavior remains advisory unless explicit confirmation is implemented.

## Dependency Updates

Dependabot is configured for routine maintenance. Semver-major updates are reviewed manually so the project can preserve the documented Node.js support target.

## Security

Do not include real tokens, credentials, private keys, or private repository data in issues, tests, fixtures, screenshots, or reports. Use clearly fake values.
