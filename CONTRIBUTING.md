# Contributing

Preserve public behavior and base reports on observable evidence. See [Usage](docs/USAGE.md) and [Architecture](docs/ARCHITECTURE.md) for workflows and safety boundaries.

## Development

Use Node.js 22 or newer, Git, and pnpm 10.30.3 as pinned in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs formatting, ESLint, TypeScript (`src` and `scripts` with `noUncheckedIndexedAccess`; `tests/tsconfig.json` relaxes only that flag), dead-code checks, build, and coverage tests. End-to-end tests run the compiled CLI that `tests/globalSetup.ts` builds once per run, and `tests/setup.ts` isolates Git from your global configuration. Run `pnpm perf` when changing parsing, file inspection, analysis, or report generation. CI tests Node.js 22 and 24 on Linux, Windows, and macOS.

The performance suite includes accepted-record byte accounting and original-input command redaction in addition to streaming verification and analysis. Real POSIX filename regressions run on Linux/macOS; Windows also exercises both path conventions through isolated semantic tests. Preserve platform-specific skips rather than treating mocked path semantics as a real filesystem test.

Ignored `.cache/` contents are regenerable test/lint/audit artifacts. Remove stale temporary audit repositories and old logs only after their processes have exited and any needed findings have been recorded. Keep dependencies and the current build/coverage outputs while using them for development or verification.

`pnpm audit:isolated -- --memory-mb 512 --format json` audits this checkout in a read-only, networkless, unprivileged Linux container with a kernel-enforced memory budget. Docker is optional for ordinary development; it is required for `pnpm verify:isolation`. CI requires that integration check, including an actual OOM-killed process and source-write refusal. See [OS-isolated analysis](docs/USAGE.md#os-isolated-analysis) for supported repositories and boundaries. Keep the Docker build-context allowlist narrow, the base-image digest verified, and all isolation arguments intact.

Before opening a pull request:

- Add focused regressions for behavior changes and update affected documentation.
- Keep changes focused; preserve public interfaces and distinctions between pre-existing changes, watcher observations, and final Git state.
- Use synthetic credentials and repository data in fixtures; review changes for sensitive-data exposure.
- Run `pnpm check` and applicable performance checks; state any verification limits.
- Inspect open CodeQL alerts as well as workflow results. A successful analysis does not mean no findings exist.

Review major dependency updates against the supported Node.js baseline. Report vulnerabilities privately as described in [Security](SECURITY.md).

## Review policy

Submit changes through a pull request with a concrete problem, validation results, and completed review checklist. `main` requires up-to-date `Analyze` and `Required checks` results from GitHub Actions, resolved review conversations, and the same protections for administrators. Force pushes and branch deletion remain blocked. CODEOWNERS routes review requests to the current maintainer.

The repository currently has one write-capable maintainer. Pull requests are required, but independent approval is not required because authors cannot approve their own pull requests. Do not describe a self-review or automated check as independent human approval. When a second trusted write-capable maintainer joins, require at least one approving review, dismiss stale approvals on new commits, and require approval of the most recent reviewable push by someone other than its author. Do not bypass checks to merge or release.

Use the bug/feature issue forms for public requests. Vulnerabilities belong in private security reporting; never attach unreviewed session reports or real credentials.

## Releases

Update `package.json`, the CLI version in `src/cli.ts`, and the exact `## X.Y.Z` heading in `CHANGELOG.md` together. Tag as `vX.Y.Z`. During `0.x`, use patches for fixes and minors for features or compatibility changes; after `1.0`, breaking changes require a major release.

For release 0.8.4, the maintainer explicitly selected the next patch version for the accumulated hardening and optional features. This exception to the 0.x feature/minor convention applies only to 0.8.4.

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

The tag triggers the release workflow, which refuses a tag outside the current protected `main` commit before installing dependencies or publishing. The active `Protect release tags` ruleset blocks updates and deletion of existing `v*` tags without bypass actors; corrections need a new version/tag. It publishes the tarball and `SHA256SUMS` as GitHub Release assets and records a provenance attestation. Do not create the release manually first; an existing release is updated with changelog notes and regenerated assets. Tag protection does not make release assets immutable; verify downloaded checksums and provenance.

From the repository root, download and verify the assets in Bash:

```sh
gh release download vX.Y.Z --repo IACBI/agent-black-box --dir artifacts --pattern '*.tgz' --pattern SHA256SUMS
sha256sum --check artifacts/SHA256SUMS
gh attestation verify artifacts/agent-black-box-X.Y.Z.tgz --repo IACBI/agent-black-box
```

The checksum manifest includes the `artifacts/` prefix. If `sha256sum` is unavailable in PowerShell, compare `Get-FileHash` with the manifest. Releases publish GitHub assets only; npm publishing is not automated.
