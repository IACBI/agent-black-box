# Releasing

Agent Black Box releases are tag-driven.

## Preflight

Run:

```sh
pnpm release:check
```

This verifies:

- TypeScript typecheck.
- Clean production build.
- Vitest test suite.
- Production dependency audit.
- Package tarball contents.

## Versioning

Update these together:

- `package.json`
- `src/cli.ts`
- `CHANGELOG.md`

Use semver:

- Patch for fixes.
- Minor for compatible features.
- Major for breaking behavior or runtime support changes.

## Create A Release

After merging to `main` and confirming CI is green:

```sh
git tag v0.3.0
git push origin v0.3.0
```

The release workflow builds, tests, packs the npm tarball, and creates a GitHub Release with the artifact attached.

## NPM Publishing

NPM publishing is intentionally not automated yet. Before enabling it, add provenance, maintainer access policy, and a manual approval gate.
