---
'jetbridge': minor
---

`configurations.available` and `variant.targets[].entitlements` are gone from the config. Both repeated something `project.pbxproj` already states, and a copy that goes stale fails a build that would have worked.

**Build configurations** are read from the project's own configuration list at build time, and `configurations.wired`, `sim` and `archive` are checked against it. Renaming a configuration in Xcode no longer needs a config edit, and a configuration only your project knows about now just works. If the project file cannot be read, the check is skipped and `xcodebuild` decides — refusing a build that would have worked is the worse mistake.

**Each target's entitlements** are read from its `CODE_SIGN_ENTITLEMENTS`. Only `variantEntitlements` stays in the config, because the reduced file is genuinely new information the project does not carry.

That removes an ambiguity about how these paths are spelled. `CODE_SIGN_ENTITLEMENTS` is relative to the Xcode project directory (`Acme/Acme.entitlements`); a config path is relative to the project root (`ios/Acme/Acme.entitlements`). The swap had to match the project's spelling byte for byte, so a config written the way the schema documents produced a `from` side that matched nothing — a loud failure, but one whose message blamed a stale project rather than the spelling. The `from` side now comes from the project itself, and `variantEntitlements` is re-expressed against the same directory before it is substituted in.

`variantEntitlements` keeps the documented root-relative spelling, and a variant build now checks the file is there **before** it registers anything at Apple, quoting the absolute path it looked at. A path spelled against the wrong directory used to surface mid-build with a profile already minted.

`jetbridge init` no longer writes either removed field. Existing configs keep working — an unknown key is ignored — but both can be deleted.
