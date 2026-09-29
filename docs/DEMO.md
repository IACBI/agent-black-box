# Demo

This walkthrough shows the local workflow without relying on any cloud service. The commands use an installed `abb` executable; in a source checkout, use `pnpm dev` instead.

The README is available in [English](../README.md#english) and [Türkçe](../README.md#turkce).

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

Inspect and compare history:

```sh
abb sessions list
abb sessions browse --state complete
abb sessions show <session-id>
abb sessions compare <older-session> <newer-session>
abb summary --session <session-id>
```

For a CI review without recording a session, inspect the Git index against a fixed commit:

```sh
abb analyze --staged --baseline HEAD --policy complete-review --format sarif
```

To manage older reports, preview eligible sessions before applying either action:

```sh
abb sessions archive --before 2026-01-01 --to .agent-black-box/archive
abb sessions prune --before 2026-01-01
```

Archiving copies and verifies reports while preserving the originals. Pruning deletes only after explicit interactive confirmation.

Rollback remains explicit:

```sh
abb rollback
abb rollback --apply --file src/example.ts
```

`abb rollback --apply` prints a plan and requires typed confirmation before restoring eligible tracked files. Files already changed at session start are excluded from automatic restore.
