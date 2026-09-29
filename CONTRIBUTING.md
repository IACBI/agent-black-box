# Contributing

Preserve public behavior and base reports on observable evidence. See [Usage](docs/USAGE.md) and [Architecture](docs/ARCHITECTURE.md) for workflows and safety boundaries.

## Development

Use Node.js 22 or newer, Git, and pnpm 10.30.3 as pinned in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs formatting, ESLint, TypeScript, dead-code checks, build, and coverage tests. Run `pnpm perf` when changing parsing, file inspection, analysis, or report generation. CI tests Node.js 22 and 24 on Linux, Windows, and macOS.

Before opening a pull request:

- Add focused regressions for behavior changes and update affected documentation.
- Keep changes focused; preserve public interfaces and distinctions between pre-existing changes, watcher observations, and final Git state.
- Use synthetic credentials and repository data in fixtures; review changes for sensitive-data exposure.
- Run `pnpm check` and applicable performance checks; state any verification limits.
- Inspect open CodeQL alerts as well as workflow results. A successful analysis does not mean no findings exist.

Review major dependency updates against the supported Node.js baseline. Report vulnerabilities privately as described in [Security](SECURITY.md).

## Releases

Update `package.json`, the CLI version in `src/cli.ts`, and the exact `## X.Y.Z` heading in `CHANGELOG.md` together. Tag as `vX.Y.Z`. During `0.x`, use patches for fixes and minors for features or compatibility changes; after `1.0`, breaking changes require a major release.

Run preflight with the intended tag. In Bash:

```sh
RELEASE_TAG=vX.Y.Z pnpm release:check
```

In PowerShell:

```powershell
$env:RELEASE_TAG = "vX.Y.Z"
try { pnpm release:check } finally { Remove-Item Env:RELEASE_TAG }
```

`release:check` runs `pnpm check`, the production dependency audit, package-content checks, and package/changelog/tag validation. Merge to `main` and confirm local preflight and hosted CI pass for that commit before tagging:

```sh
git switch main
git pull --ff-only origin main
git tag vX.Y.Z
git push origin vX.Y.Z
```

The tag triggers the release workflow. It publishes the tarball and `SHA256SUMS` as GitHub Release assets and records a provenance attestation. Do not create the release manually first; an existing release is updated with changelog notes and regenerated assets.

From the repository root, download and verify the assets in Bash:

```sh
gh release download vX.Y.Z --repo IACBI/agent-black-box --dir artifacts --pattern '*.tgz' --pattern SHA256SUMS
sha256sum --check artifacts/SHA256SUMS
gh attestation verify artifacts/agent-black-box-X.Y.Z.tgz --repo IACBI/agent-black-box
```

The checksum manifest includes the `artifacts/` prefix. If `sha256sum` is unavailable in PowerShell, compare `Get-FileHash` with the manifest. Releases publish GitHub assets only; npm publishing is not automated.
