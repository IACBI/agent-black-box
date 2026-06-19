# Demo

This transcript shows the intended local workflow without relying on any cloud service.

Full localized README documentation is available in the language section: [Languages](../README.md#languages).

```sh
abb init
abb config validate
abb doctor
```

Start a foreground session:

```sh
abb start
```

The start command records a Git baseline before watcher observations begin. Existing worktree changes remain visible in reports but are marked as pre-existing.

In another terminal, run commands through Agent Black Box when command metadata should be recorded:

```sh
abb run --label tests --group validation --phase test -- pnpm test
abb run --cwd packages/app --label app-build --group validation --phase build -- pnpm build
```

Stop and review:

```sh
abb stop
abb summary
abb risks --min-severity medium
abb export --output abb-session.md
```

Rollback remains explicit:

```sh
abb rollback
abb rollback --apply --file src/example.ts
```

`abb rollback --apply` prints a plan and requires typed confirmation before restoring eligible tracked files. Files already changed at session start are excluded from automatic restore.
