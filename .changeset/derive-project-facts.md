---
'jetbridge': minor
---

Three more config fields come from the project. **Breaking config change.**

`variant.targets[].bundleIdSuffix` and `project.projectYml` are gone, and `project.xcodeproj` is now optional. Each of them restated something the project or the directory already says, and a hand-kept copy goes stale in silence.

- **`targets[].bundleIdSuffix`** — read from `PRODUCT_BUNDLE_IDENTIFIER` on each target. The app is the target whose id every other id extends, and an extension's segment is the remainder: `io.acme.app.dev.uploadwidget` under `io.acme.app.dev` gives `uploadwidget`. A target is now `{ "name", "variantEntitlements" }` and nothing more. Delete the key.
- **`project.projectYml`** — a `project.yml` or `project.yaml` beside the project is found when it is needed. Delete the key. `project.xcodegen` stays, because regenerating before every build is a choice; it now fails clearly if it is on and no spec is beside the project.
- **`project.xcodeproj`** — inferred when `iosDir` holds exactly one `.xcodeproj`. Keep it only when the directory holds several; the error lists what it found. `project.xcworkspace` is unchanged and still wins when set.

Two consequences worth knowing before you upgrade:

- With more than one target, an unreadable project file is now fatal rather than quiet. Reading it is the only way to know an extension is an extension, and carrying on would register it under the app's own bundle id and mint a profile that signs and then refuses to install. A single-target app never reads the project at all, so it is unaffected.
- Three schema checks moved from the config to the project, where the fact actually lives: exactly one target is the app, no two targets share a bundle id, and a target's id is inside the app's. They are reported against the project file now, and they name the ids.

What stays in the config, because none of it is duplication: `targets[].name` is a selection — a project has test targets and extensions that must not get variant treatment. `project.scheme` is a real choice when a project has more than one. `project.teamId`, `project.baseBundleId` and `variant.displayName` are the dev build's identity, deliberately allowed to differ from what the project declares for release.
