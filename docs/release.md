# Release process

The repository is beta-only until the stable acceptance gate is agreed. A `prepublishOnly` guard rejects any version that does not end in `-beta.<number>` and any publish without the explicit `--tag beta` option. The GitHub workflow accepts only an exact `v<package-version>` tag and requires the tagged commit to be reachable from `main`. There is no stable or `latest` publishing path.

Physical Raspberry Pi, target-hardware and real-vessel testing are not prerequisites for an npm beta. Beta publication is the supported way to collect that field evidence. Those results remain required before declaring the plugin first-vessel or stable-production ready.

## npm beta gate

An npm beta release candidate must:

- be merged to `main` with normal CI and Signal K reusable plugin CI passing;
- pass `npm run check` and `npm audit --omit=dev --audit-level=high`;
- pass the packaged `npm run test:docker` Signal K/TLS/MQTT recovery scenario;
- pass `npm pack --dry-run`, with the intended files, beta version and Signal K metadata present; and
- have an updated changelog and no production or non-production Wake Logger endpoints, credentials or environment details in the public package.

Physical hardware results do not affect this gate. Record them separately under the first-vessel and stable-release gates.

## One-time npm bootstrap

The unscoped `signalk-wakelogger` package does not yet exist in npm. npm trusted-publisher configuration requires an existing package, so the first beta must be bootstrapped deliberately by the package owner:

1. Merge an approved release-candidate pull request to `main` after the npm beta gate above passes.
2. From a clean checkout of that exact `main` commit, use Node.js 24 and npm 12.0.2.
3. Run `npm ci --ignore-scripts`, `npm run check`, `npm audit --omit=dev --audit-level=high`, `npm run test:docker`, and `npm pack --dry-run`; inspect the file list.
4. With the npm account protected by 2FA, run `npm publish --access public --tag beta`. The prepublish guard verifies the beta version/tag and repeats the complete check automatically; a bare `npm publish` is rejected.
5. Confirm that npm shows the version under `beta`, not `latest`.

This is the only manual package publication. Do not create the Git tag before the package bootstrap succeeds.

## Configure trusted publishing

After the package exists, configure its npm trusted publisher with:

- provider: GitHub Actions
- repository: `nerdynigel/signalk-wakelogger`
- workflow filename: `publish.yml`
- allowed action: `npm publish`
- environment: `npm`

Create the GitHub `npm` environment and require a maintainer reviewer before deployment. The workflow uses a GitHub-hosted runner with `id-token: write`, Node.js 24 and npm 12.0.2. npm generates provenance automatically for trusted publication from this public repository. After the first successful OIDC beta, disallow traditional publish tokens in npm package settings.

After configuring trust, create and push the exact bootstrap-version tag. The workflow detects that the manually bootstrapped version already exists, does not republish it, and creates the matching GitHub prerelease. This also makes a safe workflow retry idempotent after npm succeeds but GitHub release creation fails.

## Subsequent betas

1. Change `package.json` and the lockfile to the next beta version and update `CHANGELOG.md`.
2. Merge only a release candidate that passes the npm beta gate to `main`.
3. Create and push the exact matching tag, such as `v0.2.0-beta.1`.
4. Verify the Publish workflow, npm provenance, `beta` dist-tag, GitHub prerelease notes and Signal K registry result.

Never reuse or move a published tag. A stable workflow must be introduced separately and reviewed against an explicitly agreed stable-release gate.
