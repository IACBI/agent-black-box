# Contributing

Thanks for helping improve Agent Black Box.

## Local setup

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

## Development expectations

- Keep changes local-first and telemetry-free.
- Avoid adding external services or network calls to runtime behavior.
- Keep reports based on observable repository evidence.
- Use cautious language for heuristic findings.
- Add or update tests when behavior changes.
- Do not commit real secrets, tokens, credentials, private keys, or private repository data.

## Pull request checklist

- `pnpm typecheck` passes.
- `pnpm build` passes.
- `pnpm test` passes.
- README or report text is updated when user-facing behavior changes.
- Rollback behavior remains advisory unless explicit confirmation is implemented.
