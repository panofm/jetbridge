# jetbridge

## 0.1.0

### Minor Changes

- [`a991afb`](https://github.com/panofm/jetbridge/commit/a991afb943f2c1211df8af6f55d23d7e383941c6) Thanks [@adamazad](https://github.com/adamazad)! - First release.

  Build, sign and deliver iOS dev builds from one config file:

  - `jetbridge sim` / `wired` / `ota` / `clean`, and `jetbridge init` to write the config by reading your Xcode project.
  - Variant builds give a branch its own bundle id and home-screen label, so two branches install side by side instead of overwriting each other.
  - Over-the-air delivery uploads an Ad Hoc `.ipa` to any S3-compatible bucket you own and prints an install URL, after checking the manifest is actually reachable over HTTPS.
  - Bundle ids, capabilities and provisioning profiles are registered through the App Store Connect API directly, because `xcodebuild -allowProvisioningUpdates` cannot register a new bundle id headlessly.

- [`a8260c0`](https://github.com/panofm/jetbridge/commit/a8260c003e488f5b0b486e8dba6501767514b68d) Thanks [@adamazad](https://github.com/adamazad)! - Renamed the command surface so each command says where a build goes.

  `install` takes the destination as a flag, the way Flutter, React Native and EAS all do, and defaults to the simulator because that route needs no credentials, no signing and no paired hardware. `link` produces a link someone else opens. `bundles` is a noun-first group in the shape of `docker image ls/rm/prune`, so the noun carries the meaning a bare verb could not.

  - `jetbridge install` / `install --device` / `install --simulator`
  - `jetbridge link`
  - `jetbridge bundles ls | provision | rm | prune`
  - `-c, --configuration` replaces `-c, --config`, which sat one keystroke from `--config-file`

  Every command now runs unattended without setting `CI=1`. Behind a pipe the non-interactive path is automatic, no command prompts when there is nobody to ask, and a child process can no longer inherit an open stdin and hang forever.
