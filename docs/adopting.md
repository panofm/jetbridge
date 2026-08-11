# Adopting jetbridge

How to take an iOS app that has never seen this tool and get to a working variant install.

The [README](../README.md) is the overview and the credential setup. This document is the part that touches your Xcode project. Read the README first if you have not.

The order matters. Each step is cheap and the next one depends on it:

1. Check the project meets the four requirements below.
2. Run `jetbridge init`.
3. Reach a working `jetbridge sim --suffix`. This needs no credentials and no signing at all.
4. Add the xcconfig wiring.
5. Add the reduced variant entitlements, if your app has capabilities the public API cannot grant.
6. Reach a working `jetbridge wired --suffix`.

## 1. What the project needs first

**A shared scheme.** `jetbridge init` reads scheme names from `xcshareddata/xcschemes` inside the `.xcodeproj` or the `.xcworkspace`. A scheme marked "Shared" in Xcode lives there. An unshared scheme is invisible to `xcodebuild` as well, so the archive step fails later with:

```
the archive reported success but produced nothing at <path>
  Check that the scheme is shared and archives from Xcode.
```

**A team id.** Ten uppercase letters and digits, on the [Membership details](https://developer.apple.com/account) page. `init` reads it from `DEVELOPMENT_TEAM` in the project, at target level or project level.

**A bundle id that is a literal.** `init` reads `PRODUCT_BUNDLE_IDENTIFIER` from the build configuration a cabled build uses. If your project assembles it from other build settings — `$(BUNDLE_PREFIX).app` — `init` says so and asks you for the value:

```
PRODUCT_BUNDLE_IDENTIFIER is built from other build settings ("$(BUNDLE_PREFIX).app.dev"),
so it has to be given by hand.
```

**One application target.** `init` finds it by product type. Extensions are found the same way and are listed with it.

### What init works out for you

`init` parses `project.pbxproj` and suggests every value below. Each suggestion carries the file it came from, and each one is shown as an editable default. Nothing is accepted silently.

| Config field                     | Read from                                                             |
| -------------------------------- | --------------------------------------------------------------------- |
| `project.iosDir`                 | where the `.xcodeproj` or `.xcworkspace` is, at the root or one below |
| `project.xcodeproj`              | the directory listing                                                 |
| `project.xcworkspace`            | the directory listing                                                 |
| `project.scheme`                 | the shared schemes, matched against the app target name               |
| `project.teamId`                 | `DEVELOPMENT_TEAM`, target first, then project                        |
| `project.baseBundleId`           | `PRODUCT_BUNDLE_IDENTIFIER` on the app target                         |
| `project.projectYml`             | a `project.yml` or `project.yaml` beside the project                  |
| `configurations.available`       | the project's own build configuration list                            |
| `variant.displayName`            | `INFOPLIST_KEY_CFBundleDisplayName`, or the target name               |
| `variant.targets`                | the app target and every extension, with their bundle-id segments     |
| `variant.targets[].entitlements` | `CODE_SIGN_ENTITLEMENTS` per target                                   |

Two details are worth knowing.

`configurations.available` comes from the **project's** configuration list, not from the union of every target's. A name that only one target defines is not a name `xcodebuild -configuration` accepts. If the project-level list cannot be read, `init` falls back to the union and warns you.

Values are read from the configuration a cabled build will use — `Debug` first. If `Debug` and `Release` carry different bundle ids, `init` uses the `Debug` one and tells you they differ. If your project has no `Debug` at all, `init` asks which configuration each mode should use, because naming one that does not exist fails deep inside `xcodebuild`.

## 2. Run init

```sh
jetbridge init
```

It detects, asks only for what it could not work out, shows you the file and the command each mode will run, and writes nothing until you confirm. It then reads the file back and validates it, so what it wrote is a file the rest of the tool accepts.

For CI or a pipe, `--yes` accepts every detected value and asks nothing. Anything it cannot work out is a hard failure that names the flag:

```
these could not be worked out from the project, and there is nobody to ask:
  project.teamId — pass --team-id
```

Running `init` again is a repair pass, not a fresh start. It compares the project against the existing file, reports what disagrees — a renamed scheme, a build configuration that no longer exists — and updates only the fields you accept. Everything else in the file is left exactly as it is.

## 3. Get to a working simulator install

Do this before you touch signing:

```sh
jetbridge sim --suffix wave
```

A simulator validates no code signature. This path needs no certificate, no provisioning profile and no App Store Connect key, and it never calls the provisioner. If it works, your scheme, configuration and build are correct, and everything left is signing.

At this stage the variant is not really a variant yet: without the xcconfig wiring in the next step, the build ignores the suffix and installs under the plain bundle id. The install still proves the build works.

## 4. The xcconfig wiring

This is the part no tool can work out for you.

jetbridge passes build settings on the `xcodebuild` command line. Your project decides what they mean. A command-line build setting overrides the same setting from any xcconfig or target, which is what makes this work.

These are the default names. All of them are configurable under `variant.buildSettings`.

| Setting                       | Value jetbridge passes        | What your project does with it        |
| ----------------------------- | ----------------------------- | ------------------------------------- |
| `JETBRIDGE_BUNDLE_SUFFIX`     | `.wave` — only for a variant  | append to `PRODUCT_BUNDLE_IDENTIFIER` |
| `JETBRIDGE_DISPLAY_NAME`      | `Acme Wave`                   | `INFOPLIST_KEY_CFBundleDisplayName`   |
| `JETBRIDGE_SIGN_STYLE`        | `Manual` — only for a variant | `CODE_SIGN_STYLE`                     |
| `JETBRIDGE_PROFILE_APP`       | the generated profile name    | `PROVISIONING_PROFILE_SPECIFIER`      |
| `JETBRIDGE_PROFILE_<SEGMENT>` | one per extension             | the same, on that extension's target  |

The profile setting name is built from the target's `bundleIdSuffix`, uppercased: an extension with `"bundleIdSuffix": "uploadwidget"` gets `JETBRIDGE_PROFILE_UPLOADWIDGET`. The app itself, which has no suffix, gets `JETBRIDGE_PROFILE_APP`. Set `profileSetting` on the target to choose a different name.

### With xcconfig files

Add these lines to the xcconfig your app target uses.

```
// Empty for a plain build; jetbridge passes ".wave" for a variant.
JETBRIDGE_BUNDLE_SUFFIX =
JETBRIDGE_SIGN_STYLE = Automatic
JETBRIDGE_DISPLAY_NAME = Acme Dev

PRODUCT_BUNDLE_IDENTIFIER = io.acme.app.dev$(JETBRIDGE_BUNDLE_SUFFIX)
INFOPLIST_KEY_CFBundleDisplayName = $(JETBRIDGE_DISPLAY_NAME)
CODE_SIGN_STYLE = $(JETBRIDGE_SIGN_STYLE)
PROVISIONING_PROFILE_SPECIFIER = $(JETBRIDGE_PROFILE_APP)
```

The three defaults at the top are what makes a plain build and a build from the Xcode GUI keep working. jetbridge only passes the suffix and the sign style for a variant, so without a default the settings resolve empty and the GUI build gets no display name and automatic signing turned off.

For an extension, add the same lines to that target's xcconfig, with its own two values:

```
PRODUCT_BUNDLE_IDENTIFIER = io.acme.app.dev$(JETBRIDGE_BUNDLE_SUFFIX).uploadwidget
PROVISIONING_PROFILE_SPECIFIER = $(JETBRIDGE_PROFILE_UPLOADWIDGET)
```

### Without xcconfig files

If the project sets build settings in the Xcode UI, you have two routes, and the right answer uses both.

**For the bundle suffix, use the same indirection.** Select the target, open **Build Settings**, find **Product Bundle Identifier**, and set it to:

```
io.acme.app.dev$(JETBRIDGE_BUNDLE_SUFFIX)
```

An undefined build setting expands to nothing, so a plain build and a build from the GUI both resolve to `io.acme.app.dev`. This one needs the indirection because the value is a fragment, not the whole setting.

**For the other three, skip the indirection and rename the settings.** Every other value jetbridge passes is the complete value of a real Xcode setting, so point jetbridge at the Xcode name and let the command line override it directly:

```jsonc
"variant": {
  "displayName": "Acme Dev",
  "buildSettings": {
    "displayName": "INFOPLIST_KEY_CFBundleDisplayName",
    "signStyle": "CODE_SIGN_STYLE",
  },
  "targets": [{ "name": "Acme", "profileSetting": "PROVISIONING_PROFILE_SPECIFIER" }],
}
```

Nothing in the project changes, and a plain build is untouched, because jetbridge passes the sign style and the profile only for a variant.

**One limit.** A command-line build setting applies to every target in the build. Renaming `profileSetting` to `PROVISIONING_PROFILE_SPECIFIER` works for a single-target app only — with an extension, both targets would receive the same profile name. For more than one target, add a **User-Defined** setting named `JETBRIDGE_PROFILE_APP` to the app target and `JETBRIDGE_PROFILE_UPLOADWIDGET` to the extension, and set each target's **Provisioning Profile** to `$(...)` of its own.

## 5. Reduced variant entitlements

Skip this if your app declares no entitlements. If it does, read it: this is the most common reason a variant fails to sign.

### Why a second file is needed

A variant build registers a new bundle id and mints a profile for it through the public App Store Connect API. That API cannot grant every capability. App groups and Sign in with Apple are the two that come up first: they cannot be enabled through it, so the generated profile does not carry them.

Signing checks the entitlements file against the profile. An entitlement in the file that the profile does not carry fails the build. Your shipping entitlements file is therefore correct for a plain build and wrong for a variant.

The fix is a second file with those entitlements removed, used only for a variant.

### Making the copy

1. Copy the target's entitlements file beside the original, e.g. `Acme/Acme.variant.entitlements`.
2. Remove every entitlement the App Store Connect API cannot grant. In practice: `com.apple.security.application-groups`, `com.apple.developer.applesignin`, and anything else your team enabled by hand in the developer portal rather than through the API.
3. Keep the rest. `aps-environment` for push stays, as long as the target lists `PUSH_NOTIFICATIONS` in `capabilities` — jetbridge enables that one through the API for you.
4. Add the file to the project. It does not need to be in a build phase; the swap only rewrites a build setting.

### Declaring the pair

```jsonc
"variant": {
  "displayName": "Acme Dev",
  "targets": [
    {
      "name": "Acme",
      "entitlements": "ios/Acme/Acme.entitlements",
      "variantEntitlements": "ios/Acme/Acme.variant.entitlements",
      "capabilities": ["PUSH_NOTIFICATIONS"],
    },
  ],
}
```

Both paths are relative to the project root and must stay inside it.

For a variant build, jetbridge rewrites the `CODE_SIGN_ENTITLEMENTS` line in `project.pbxproj` to the reduced file, and restores the original bytes the moment the build returns — before the install runs, and on `SIGINT`, `SIGTERM` or `SIGHUP` as well. Only that one line changes. A plain build swaps nothing.

The path in the config must match the way the project spells it, character for character. If it does not, the swap fails loudly rather than building the wrong thing:

```
the entitlement swap matched no CODE_SIGN_ENTITLEMENTS in the project file.
  Check that variant.targets[].entitlements matches the path the project spells,
  and regenerate the project if it is stale.
```

## 6. Extensions

An extension ships inside the app, so it needs its own bundle id, its own registration and its own profile. Give it its own entry with a `bundleIdSuffix`:

```jsonc
"targets": [
  { "name": "Acme" },
  { "name": "UploadWidget", "bundleIdSuffix": "uploadwidget" },
]
```

The suffix is one bundle-id segment: lowercase letters and digits only.

jetbridge builds the ids so the extension always nests under the app:

```
app        io.acme.app.dev.wave
extension  io.acme.app.dev.wave.uploadwidget
```

That nesting is what iOS requires of a container and its extension. Never give an extension a `bundleIdSuffix` that would put it somewhere else in the tree.

Exactly one target leaves `bundleIdSuffix` unset — that is the app. Two would both claim the app's bundle id and overwrite each other's profile, so the config schema refuses it.

## 7. First-run checklist

```sh
# 1. Write the config.
jetbridge init

# 2. Build and launch on a simulator. No credentials, no signing.
jetbridge sim

# 3. The same as a variant. Still no credentials.
jetbridge sim --suffix wave
```

Stop here until step 3 works. Then add the xcconfig wiring from step 4 and run it again: the app should now install beside the plain one, with its own home-screen label.

```sh
# 4. Confirm the variant really is a separate app.
jetbridge sim --suffix wave
```

Only then set up credentials — the README covers this — and go to the device:

```sh
# 5. Register the bundle id, mint a profile, build and install over the cable.
jetbridge wired --suffix wave
```

If step 5 fails, [troubleshooting.md](./troubleshooting.md) is organised by the message you actually see.

### What each step proves

| Step                       | Needs a key | What a pass tells you                                        |
| -------------------------- | ----------- | ------------------------------------------------------------ |
| `jetbridge sim`            | no          | the scheme, the configuration and the build are right        |
| `jetbridge sim --suffix`   | no          | the xcconfig wiring resolves the suffix                      |
| `jetbridge wired`          | no          | the device is reachable and the plain build signs            |
| `jetbridge wired --suffix` | **yes**     | registration, provisioning and the entitlement swap all work |

`jetbridge wired --suffix` refuses before it builds anything when this machine has no credentials:

```
a variant build has to register a new bundle id, which needs App Store Connect credentials.
  Drop the variant to build the plain bundle id instead.
```
