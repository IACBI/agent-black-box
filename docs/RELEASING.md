# Releasing

Agent Black Box releases are tag-driven.

Full localized README documentation is available in the language section: [Languages](../README.md#languages).

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
git tag vX.Y.Z
git push origin vX.Y.Z
```

The release workflow builds, tests, packs the npm tarball, and creates a GitHub Release with the artifact attached.

Do not create the GitHub Release manually before pushing the tag. If a release already exists for the tag, the workflow updates its notes from `CHANGELOG.md` and replaces the generated tarball asset instead of failing.

## NPM Publishing

NPM publishing is intentionally not automated yet. Before enabling it, add provenance, maintainer access policy, and a manual approval gate.
