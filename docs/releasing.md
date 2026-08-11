# Releasing

Releases go through [Changesets](https://github.com/changesets/changesets). Nothing is published from a laptop.

## Every publishable change carries a changeset

A pull request that touches `packages/cli/src`, `packages/cli/templates`, `packages/cli/schema`, its `package.json` or its `README.md` must include one. CI fails the PR otherwise — a change that ships unversioned is invisible, and one that never ships at all goes unnoticed for a week.

```sh
bunx changeset      # pick patch / minor / major, describe the change
git add .changeset
```

Write the description for someone reading the changelog, not for the diff: what changed for them, and why.

## Then it is automatic

1. The PR lands on `main`. The release workflow opens a **"chore(release): version packages"** PR that bumps the version, writes the CHANGELOG and deletes the consumed changesets.
2. Merging that PR publishes to npm and pushes the git tag.

The only requirement is an `NPM_TOKEN` automation token in the repository's `npm-publish` environment. Automation tokens bypass two-factor prompts by design, which is why CI needs that kind rather than a classic publish token.

## Prerelease mode

The project is currently in **pre mode with the `rc` tag**, so a version PR produces `0.1.0-rc.N` and publishes under the `rc` dist-tag rather than cutting `0.1.0`.

```sh
bunx changeset pre exit     # when the release is ready to be the real one
```

Leave pre mode only once the package has been proven in a real project — the point of the rc train is that adopting it is the test.

## Notes that cost time to relearn

- **npm claims `latest` on the first publish**, whatever `--tag` says, because there is nothing else to point at. It corrects itself when a non-prerelease version ships.
- **No npm provenance.** It requires a public source repository; this one is private, so npm rejects provenance with `E422`. Auth is the token.
- **The version PR needs a repository setting**: Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests". Without it the workflow cannot open or update that PR.
