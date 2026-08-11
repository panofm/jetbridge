# jetbridge

## 0.1.0-rc.2

### Minor Changes

- [`1576527`](https://github.com/panofm/jetbridge/commit/157652777bdc9851af37c39380863a2d7bbaac93) Thanks [@adamazad](https://github.com/adamazad)! - Capabilities come from the entitlements file. **Breaking config change.**

  `variant.targets[].capabilities` is gone. Delete it — a config that still carries it is not an error, the key is ignored. jetbridge now reads the target's `variantEntitlements` file (the `entitlements` file when there is no variant one) and enables the App Store Connect capabilities its keys imply: `aps-environment` → `PUSH_NOTIFICATIONS`, `com.apple.developer.associated-domains` → `ASSOCIATED_DOMAINS`, `com.apple.security.application-groups` → `APP_GROUPS`, and thirteen more.

  A hand-kept list drifts from the file it is supposed to describe: the config says `PUSH_NOTIFICATIONS`, someone edits the entitlements, and nothing notices until a build signs against a profile missing a capability. The entitlements file already states the same facts, so it is now the only place that states them.

  Notes on what changes for a project that upgrades:

  - A target with no entitlements file asks for no capabilities. That is the common case and it is fine.
  - The reduced `variantEntitlements` file is preferred deliberately. It is where a project drops what the public API cannot grant, so deriving from the shipping file would ask Apple for capabilities it refuses.
  - An entitlement key jetbridge does not recognise is skipped. Apple adds entitlements constantly and an unknown one must never fail a build.
  - An entitlements file that is declared but not on disk yields no capabilities; one that is on disk and does not parse fails the run.
  - If a target has only a shipping `entitlements` file that declares app groups or Sign in with Apple, jetbridge now asks App Store Connect to enable them where a hand-written empty `capabilities` list previously asked for nothing. Give that target a `variantEntitlements` file with those keys removed — which is what a variant build needs anyway.

- [`f397049`](https://github.com/panofm/jetbridge/commit/f397049e5ff8c6d81e2145d8aadc80c41ce63cfb) Thanks [@adamazad](https://github.com/adamazad)! - `configurations.available` and `variant.targets[].entitlements` are gone from the config. Both repeated something `project.pbxproj` already states, and a copy that goes stale fails a build that would have worked.

  **Build configurations** are read from the project's own configuration list at build time, and `configurations.wired`, `sim` and `archive` are checked against it. Renaming a configuration in Xcode no longer needs a config edit, and a configuration only your project knows about now just works. If the project file cannot be read, the check is skipped and `xcodebuild` decides — refusing a build that would have worked is the worse mistake.

  **Each target's entitlements** are read from its `CODE_SIGN_ENTITLEMENTS`. Only `variantEntitlements` stays in the config, because the reduced file is genuinely new information the project does not carry.

  That removes an ambiguity about how these paths are spelled. `CODE_SIGN_ENTITLEMENTS` is relative to the Xcode project directory (`Acme/Acme.entitlements`); a config path is relative to the project root (`ios/Acme/Acme.entitlements`). The swap had to match the project's spelling byte for byte, so a config written the way the schema documents produced a `from` side that matched nothing — a loud failure, but one whose message blamed a stale project rather than the spelling. The `from` side now comes from the project itself, and `variantEntitlements` is re-expressed against the same directory before it is substituted in.

  `variantEntitlements` keeps the documented root-relative spelling, and a variant build now checks the file is there **before** it registers anything at Apple, quoting the absolute path it looked at. A path spelled against the wrong directory used to surface mid-build with a profile already minted.

  `jetbridge init` no longer writes either removed field. Existing configs keep working — an unknown key is ignored — but both can be deleted.

- [`f397049`](https://github.com/panofm/jetbridge/commit/f397049e5ff8c6d81e2145d8aadc80c41ce63cfb) Thanks [@adamazad](https://github.com/adamazad)! - Three more config fields come from the project. **Breaking config change.**

  `variant.targets[].bundleIdSuffix` and `project.projectYml` are gone, and `project.xcodeproj` is now optional. Each of them restated something the project or the directory already says, and a hand-kept copy goes stale in silence.

  - **`targets[].bundleIdSuffix`** — read from `PRODUCT_BUNDLE_IDENTIFIER` on each target. The app is the target whose id every other id extends, and an extension's segment is the remainder: `io.acme.app.dev.uploadwidget` under `io.acme.app.dev` gives `uploadwidget`. A target is now `{ "name", "variantEntitlements" }` and nothing more. Delete the key.
  - **`project.projectYml`** — a `project.yml` or `project.yaml` beside the project is found when it is needed. Delete the key. `project.xcodegen` stays, because regenerating before every build is a choice; it now fails clearly if it is on and no spec is beside the project.
  - **`project.xcodeproj`** — inferred when `iosDir` holds exactly one `.xcodeproj`. Keep it only when the directory holds several; the error lists what it found. `project.xcworkspace` is unchanged and still wins when set.

  A generated project — `project.yml` committed, `.xcodeproj` gitignored — keeps working on a fresh clone, where there is nothing to infer yet. Loading succeeds (`bundles ls` never builds anything), the name is resolved again the moment XcodeGen writes the project, and every command that needs the file and cannot find it now says to run `xcodegen generate` rather than pointing at `project.iosDir`. `generateProject` also moved ahead of provisioning in the cabled and over-the-air flows, because provisioning is what reads the project for each extension's bundle id — and it is the step that permanently registers things with Apple.

  Two consequences worth knowing before you upgrade:

  - With more than one target, an unreadable project file is now fatal rather than quiet. Reading it is the only way to know an extension is an extension, and carrying on would register it under the app's own bundle id and mint a profile that signs and then refuses to install. A single-target app never reads the project at all, so it is unaffected.
  - Three schema checks moved from the config to the project, where the fact actually lives: exactly one target is the app, no two targets share a bundle id, and a target's id is inside the app's. They are reported against the project file now, and they name the ids.

  What stays in the config, because none of it is duplication: `targets[].name` is a selection — a project has test targets and extensions that must not get variant treatment. `project.scheme` is a real choice when a project has more than one. `project.teamId`, `project.baseBundleId` and `variant.displayName` are the dev build's identity, deliberately allowed to differ from what the project declares for release.

- [`260bcfd`](https://github.com/panofm/jetbridge/commit/260bcfd26900b297cbde1f2d267f866689cccac0) Thanks [@adamazad](https://github.com/adamazad)! - Build setting names are fixed, not configurable. **Breaking config change.**

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

## 0.1.0-rc.1

### Minor Changes

- [`3a31835`](https://github.com/panofm/jetbridge/commit/3a31835af9196992deb6804b98a9e1c661287145) Thanks [@adamazad](https://github.com/adamazad)! - Every command now reports what it is doing while it does it. The app, its bundle id and its configuration, the devices, and the profiles that will sign the build are printed BEFORE anything slow starts — so a wrong `--suffix` costs a second instead of a full build — and each slow phase is a timed step that announces itself and rewrites its own line when it finishes. Nothing is silent for minutes, and the build number is reported with where the same number appears on the phone. Without a terminal, each step prints one plain line and no escape codes.

  `--json` on any command puts newline-delimited events on **stdout**, one object per line, while every human line stays on **stderr** — so a script can pipe stdout to a parser while a person watches the run. Events cover the start, the resolved devices, the signing decision and which profiles it used, each step with its duration in milliseconds, each per-device install, the `link` URLs, and a final `done` with the total and an `ok` flag. A failure emits `error` and then `done` with `"ok": false`, and the exit code stays non-zero. `bundles ls --json` keeps its existing array output unchanged.

  Build hook output is captured rather than inherited, and quoted on failure — a hook that printed its own banner used to repeat the line the runner had just drawn.

  Everything a step prints from inside itself — one line per profile provisioned — is now indented under that step instead of landing on its half-drawn line, and the step column is sized to the run's own labels so one long device name cannot push every other duration out of alignment. Progress lines are no longer dropped without a terminal: a redirected log now carries every one of them, in order, with no escape codes.

### Patch Changes

- [`b99becf`](https://github.com/panofm/jetbridge/commit/b99becf5235d5426b3a243a42a0a7d65e95076aa) Thanks [@adamazad](https://github.com/adamazad)! - Fixes over-the-air delivery failing with "There are no current certificates on this team matching the provided certificate IDs compatible with IOS_APP_ADHOC profiles".

  The certificate kind now follows the profile type: a development profile embeds a development certificate, ad hoc and in-house embed a distribution one. Requesting an ad hoc profile while looking up a development certificate is a pairing Apple rejects, with a 409 that reads like a missing certificate rather than the wrong kind of one.

  `ota.exportMethod` gains `development`, and it is now the default. It produces an `.ipa` that installs over the air on every device named in the profile, signed with the certificate every Apple developer already has — where `ad-hoc` and `enterprise` need a distribution certificate the team may never have issued. When one is genuinely missing, the error now says which setting avoids needing it.

- [`6f6c3f6`](https://github.com/panofm/jetbridge/commit/6f6c3f6a81a0fc042ccab451e3a0a7bc9a08ea70) Thanks [@adamazad](https://github.com/adamazad)! - Reads `.env.local` and `.env` from the project root, so App Store Connect credentials no longer have to be exported by hand before every command.

  Git worktrees are handled too: a worktree has its own root but no `.env.local` — the file lives only in the main checkout and is git-ignored, so it never propagates. Without the fallback, every build from a worktree looked credential-less on a machine that was configured correctly.

  A file never overwrites a variable that is already set, so exporting one still wins.
