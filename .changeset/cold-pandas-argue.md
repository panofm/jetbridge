---
'jetbridge': minor
---

First release.

Build, sign and deliver iOS dev builds from one config file:

- `jetbridge install` puts a build on a simulator or, with `--device`, on a cabled phone. `jetbridge link` uploads it and prints a link anyone can install from. `jetbridge init` writes the config by reading your Xcode project.
- Variant builds give a branch its own bundle id and home-screen label, so two branches install side by side instead of overwriting each other.
- Over-the-air delivery uploads an Ad Hoc `.ipa` to any S3-compatible bucket you own, and checks the manifest is actually reachable over HTTPS before printing a link — a bucket that is not publicly readable returns 403, and iOS reports only "Cannot connect".
- `jetbridge bundles ls / provision / rm / prune` manages what those variants register with Apple. Deleting is a dry run by default, because Apple restores nothing.
- Bundle ids, capabilities and provisioning profiles are registered through the App Store Connect API directly, because `xcodebuild -allowProvisioningUpdates` cannot register a new bundle id headlessly.
- Every command runs unattended: no `CI` variable to set, nothing prompts when there is nobody to ask, and no child process can inherit an open stdin and hang.
