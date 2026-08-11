---
'jetbridge': minor
---

`jetbridge init` now sets up the reduced variant entitlements, and writes a shorter config.

- The wizard fills in `variantEntitlements` for each target when it finds the reduced file beside the shipping one — as a sibling, or in a `config/` directory next to it — and asks when it does not, saying what the file is for and that it can be left empty. Missing it used to be invisible until a variant build failed at signing, long after setup looked like it had worked.
- A target that keeps app groups or Sign in with Apple with no reduced file to swap in is now named at the end of the run. Those are capabilities the App Store Connect API cannot grant a newly registered bundle id, so that build cannot sign — better heard from the wizard than from Xcode twenty minutes later.
- The generated config holds only what differs from the defaults. A `credentials` block restating `${ASC_API_KEY_ID}`, or a `configurations` block naming Debug and Release, is left out. Nothing behaves differently: anything absent is what the schema already supplies.
- The end of setup now prints the commands you actually run next — `jetbridge install`, `jetbridge install --device` and `jetbridge link` — each with the build configuration your answers pointed it at, in place of the xcodebuild command lines nobody types.
