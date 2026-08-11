---
'jetbridge': minor
---

First release.

Build, sign and deliver iOS dev builds from one config file:

- `jetbridge install` puts a build on a simulator, or on a cabled phone with `--device`. `jetbridge link` uploads it and prints a link anyone can install from. `jetbridge init` writes the config by reading your Xcode project.
- Variant builds give a branch its own bundle id and home-screen label, so two branches install side by side instead of overwriting each other.
- Over-the-air delivery uploads to any S3-compatible bucket you own, and fetches the manifest back over HTTPS before printing a link — a bucket that is not publicly readable answers 403, and iOS reports only "Cannot connect".
- `jetbridge bundles ls / provision / rm / prune` manages what those variants register with Apple. Deleting is a dry run by default, and pruning aborts if the git remote cannot be reached, because offline must never read as "every branch is gone".
- Bundle ids, capabilities and provisioning profiles are registered through the App Store Connect API directly, because `xcodebuild -allowProvisioningUpdates` cannot register a new bundle id headlessly.
- The config holds decisions only. The build configurations, each target's entitlements and bundle-id segment, and the capabilities to register are read from the Xcode project itself. Secrets are referenced as `${VAR}` and never held.
- Your project consumes five fixed build settings — `JETBRIDGE_SUFFIX`, `JETBRIDGE_DISPLAY_NAME`, `JETBRIDGE_SIGN_STYLE`, `JETBRIDGE_GIT_SHA` and `JETBRIDGE_PROFILE_<TARGET>`.
- Every command reports timed steps while it works, prints the identity and signing decision before anything slow, and takes `--json` for scripts and agents.
- Every command runs unattended: no `CI` variable to set, nothing prompts when there is nobody to ask, and no child process can inherit an open stdin and hang.
