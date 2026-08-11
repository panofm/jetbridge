---
'jetbridge': minor
---

Build setting names are fixed, not configurable. **Breaking config change.**

`variant.buildSettings` and `targets[].profileSetting` are gone. A config that still sets either is not an error — the keys are ignored, so delete them, and do not read the build from a name they used to map. jetbridge passes these names on the `xcodebuild` command line, and your project consumes them as they are:

- `JETBRIDGE_SUFFIX` — the bundle-id suffix, e.g. `.seededfeed`
- `JETBRIDGE_DISPLAY_NAME` — the home-screen label
- `JETBRIDGE_SIGN_STYLE` — `Manual` for a variant
- `JETBRIDGE_GIT_SHA` — the provenance stamp, when there is one
- `JETBRIDGE_PROFILE_<TARGET>` — the generated profile name, one per target

To upgrade:

1. Delete `variant.buildSettings` and every `profileSetting` from `jetbridge.config.json`.
2. Rename `JETBRIDGE_BUNDLE_SUFFIX` to `JETBRIDGE_SUFFIX` in your xcconfig, `project.yml`, or Xcode build settings. This is the one rename that breaks a build silently: the suffix never reaches the bundle id, so the variant installs under the plain id and overwrites the app it was meant to sit beside.
3. If you had mapped a name to a real Xcode setting — `CODE_SIGN_STYLE`, `INFOPLIST_KEY_CFBundleDisplayName`, `PROVISIONING_PROFILE_SPECIFIER` — read the `JETBRIDGE_*` setting from that setting instead: `CODE_SIGN_STYLE = $(JETBRIDGE_SIGN_STYLE)`. See [Adopting jetbridge](docs/adopting.md#4-the-xcconfig-wiring).
