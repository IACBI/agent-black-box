# Releasing

Agent Black Box releases are tag-driven.

Full localized README documentation is available in the language section: [Languages](../README.md#languages).

## Preflight

Run:

```sh
pnpm release:check
```

This verifies:

- Formatting, linting, and TypeScript typecheck.
- Dead source-file and production dependency analysis.
- Clean production build.
- Vitest suite with coverage thresholds.
- Production dependency audit.
- Package tarball contents.
- The release tag matches `package.json` and `CHANGELOG.md`.

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
git tag vX.Y.Z
git push origin vX.Y.Z
```

The release workflow builds, tests, audits production dependencies, validates version alignment, packs the npm tarball, writes `SHA256SUMS`, and creates a GitHub Release with the artifacts attached.

Do not create the GitHub Release manually before pushing the tag. If a release already exists for the tag, the workflow updates its notes from `CHANGELOG.md` and replaces the generated tarball asset instead of failing.

## NPM Publishing

NPM publishing is intentionally not automated yet. Before enabling it, configure npm trusted publishing, provenance, a protected GitHub environment, least-privilege `id-token` permissions, maintainer access policy, and a manual approval gate. Do not store a long-lived npm token in the repository.
