# jetbridge

Build, sign and deliver iOS dev builds — to a simulator, down a cable, or over the air to your own bucket.

**→ [Package documentation](packages/cli/README.md)** — install it, configure it, use it.

## This repository

| Path                           | What it is                                                |
| ------------------------------ | --------------------------------------------------------- |
| [`packages/cli`](packages/cli) | the `jetbridge` package published to npm                  |
| [`docs/`](docs)                | guides: adopting, credentials, troubleshooting, releasing |
| `scripts/`                     | repo-wide gates that run in CI                            |

## Working on it

The workspace is managed with [Bun](https://bun.sh). The package it publishes targets **Node** — CI runs the tests under Node so that stays true, and Bun never becomes a runtime dependency.

```sh
bun install
bun run check     # typecheck, lint, format, schema, identifiers, tests
bun run test
bun run build
```

Nearly every line of this tool shells out to `xcodebuild`, `devicectl`, `simctl` or `security`, calls App Store Connect, or writes to a bucket. All of it goes through one injected boundary, so the whole suite runs without a Mac, a paired phone, an Apple team or a bucket — and without touching the network.

Two gates worth knowing about before you open a pull request:

1. **A change to anything published needs a changeset.** `bunx changeset`, then commit the generated file. Without it the change reaches npm unversioned, or never ships and nobody notices for a week.
2. **No private identifiers.** This package was extracted from a private codebase, and CI fails the build if a team id, production host, bundle id or private build-setting name reappears anywhere — code, comments, tests, fixtures or templates.

See **[Releasing](docs/releasing.md)** for how a merged change reaches npm.

## License

MIT
