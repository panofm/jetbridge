---
'jetbridge': minor
---

First release.

Build, sign and deliver iOS dev builds from one config file:

- `jetbridge sim` / `wired` / `ota` / `clean`, and `jetbridge init` to write the config by reading your Xcode project.
- Variant builds give a branch its own bundle id and home-screen label, so two branches install side by side instead of overwriting each other.
- Over-the-air delivery uploads an Ad Hoc `.ipa` to any S3-compatible bucket you own and prints an install URL, after checking the manifest is actually reachable over HTTPS.
- Bundle ids, capabilities and provisioning profiles are registered through the App Store Connect API directly, because `xcodebuild -allowProvisioningUpdates` cannot register a new bundle id headlessly.
