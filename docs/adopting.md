# Adopting jetbridge

How to take an iOS app that has never seen this tool and get to a working variant install.

The [README](../README.md) is the overview and the credential setup. This document is the part that touches your Xcode project. Read the README first if you have not.

The order matters. Each step is cheap and the next one depends on it:

1. Check the project meets the four requirements below.
2. Run `jetbridge init`.
3. Reach a working `jetbridge install`. This needs no credentials and no signing at all.
4. Add the xcconfig wiring, then reach a working `jetbridge install --suffix`.
5. Add the reduced variant entitlements, if your app has capabilities the public API cannot grant.
6. Reach a working `jetbridge install --device --suffix`.

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
jetbridge install
```

The simulator is the default destination, for exactly this reason: it validates no code signature. This path needs no certificate, no provisioning profile, no App Store Connect key and no paired phone, and it never calls the provisioner. So the first command you run always works. If it does, your scheme, configuration and build are correct, and everything left is signing.

`jetbridge install --simulator` is the same thing said out loud. `--device` is the other destination, and step 7 gets to it. Both take an optional value, so one flag answers both questions — where to install, and which one:

```sh
jetbridge install                             # any available simulator
jetbridge install --simulator "iPhone 17 Pro" # that simulator
jetbridge install --device                    # every reachable paired phone
jetbridge install --device "Dev's iPhone"     # that phone
```

Naming both is an error: `pass --device or --simulator, not both`.

Do not use `--suffix` yet. Until the wiring in the next step is in place, the build ignores the suffix and produces the plain bundle id, while the install step looks for the variant one — so the app installs and then fails to launch:

```
installed io.acme.app.dev.wave but could not launch it on <simulator>:
  <what simctl said>
  Open it from the simulator home screen to see why.
```

That failure is the check for step 4, not a problem with step 3.

## 4. The xcconfig wiring

This is the part no tool can work out for you.

jetbridge passes build settings on the `xcodebuild` command line. Your project decides what they mean. A command-line build setting overrides the same setting from any xcconfig or target, which is what makes this work.

These names are fixed. Your project consumes them as they are — there is nothing to configure.

| Setting                       | Value jetbridge passes        | What your project does with it        |
| ----------------------------- | ----------------------------- | ------------------------------------- |
| `JETBRIDGE_SUFFIX`            | `.wave` — only for a variant  | append to `PRODUCT_BUNDLE_IDENTIFIER` |
| `JETBRIDGE_DISPLAY_NAME`      | `Acme Wave`                   | `INFOPLIST_KEY_CFBundleDisplayName`   |
| `JETBRIDGE_SIGN_STYLE`        | `Manual` — only for a variant | `CODE_SIGN_STYLE`                     |
| `JETBRIDGE_GIT_SHA`           | `abc1234` — when there is one | whatever you stamp it into            |
| `JETBRIDGE_PROFILE_APP`       | the generated profile name    | `PROVISIONING_PROFILE_SPECIFIER`      |
| `JETBRIDGE_PROFILE_<SEGMENT>` | one per extension             | the same, on that extension's target  |

The profile setting name is built from the target's `bundleIdSuffix`, uppercased: an extension with `"bundleIdSuffix": "uploadwidget"` gets `JETBRIDGE_PROFILE_UPLOADWIDGET`. The app itself, which has no suffix, gets `JETBRIDGE_PROFILE_APP`.

### With xcconfig files

Add these lines to the xcconfig your app target uses.

```
// Empty for a plain build; jetbridge passes ".wave" for a variant.
JETBRIDGE_SUFFIX =
JETBRIDGE_SIGN_STYLE = Automatic
JETBRIDGE_DISPLAY_NAME = Acme Dev

// io.acme.app.dev is project.baseBundleId, spelled the same on both sides.
PRODUCT_BUNDLE_IDENTIFIER = io.acme.app.dev$(JETBRIDGE_SUFFIX)
// Acme Dev above is variant.displayName.
INFOPLIST_KEY_CFBundleDisplayName = $(JETBRIDGE_DISPLAY_NAME)
CODE_SIGN_STYLE = $(JETBRIDGE_SIGN_STYLE)
// One per entry in variant.targets; JETBRIDGE_PROFILE_APP is the app itself.
PROVISIONING_PROFILE_SPECIFIER = $(JETBRIDGE_PROFILE_APP)
```

### With a generated project

If XcodeGen builds the project (`project.projectYml`), the same four lines go in the target's `settings` block of `project.yml`, with the jetbridge config key that supplies each value:

```yaml
settings:
  # project.baseBundleId
  PRODUCT_BUNDLE_IDENTIFIER: io.acme.app.dev$(JETBRIDGE_SUFFIX)
  # variant.displayName
  INFOPLIST_KEY_CFBundleDisplayName: $(JETBRIDGE_DISPLAY_NAME)
  CODE_SIGN_STYLE: $(JETBRIDGE_SIGN_STYLE)
  # variant.targets[] — one JETBRIDGE_PROFILE_<SEGMENT> per target
  PROVISIONING_PROFILE_SPECIFIER: $(JETBRIDGE_PROFILE_APP)
```

Keep the same three defaults (`JETBRIDGE_SUFFIX`, `JETBRIDGE_SIGN_STYLE`, `JETBRIDGE_DISPLAY_NAME`) in the base `settings`, so a build from the Xcode GUI still resolves them.

The three defaults at the top are what makes a plain build and a build from the Xcode GUI keep working. jetbridge only passes the suffix and the sign style for a variant, so without a default the settings resolve empty and the GUI build gets no display name and automatic signing turned off.

For an extension, add the same lines to that target's xcconfig, with its own two values:

```
PRODUCT_BUNDLE_IDENTIFIER = io.acme.app.dev$(JETBRIDGE_SUFFIX).uploadwidget
PROVISIONING_PROFILE_SPECIFIER = $(JETBRIDGE_PROFILE_UPLOADWIDGET)
```

### Without xcconfig files

If the project sets build settings in the Xcode UI, do the same four lines by hand. Select the target and open **Build Settings**.

1. **Add three User-Defined settings** — `JETBRIDGE_SUFFIX` (empty), `JETBRIDGE_SIGN_STYLE` = `Automatic`, `JETBRIDGE_DISPLAY_NAME` = `Acme Dev`, which is `variant.displayName`. They are the defaults a plain build and a build from the GUI resolve to.
2. **Product Bundle Identifier** → `io.acme.app.dev$(JETBRIDGE_SUFFIX)`, where `io.acme.app.dev` is `project.baseBundleId`.
3. **Bundle Display Name** → `$(JETBRIDGE_DISPLAY_NAME)`.
4. **Code Signing Style** → `$(JETBRIDGE_SIGN_STYLE)`.
5. **Provisioning Profile** → `$(JETBRIDGE_PROFILE_APP)`, and add a User-Defined `JETBRIDGE_PROFILE_APP` with an empty default.

A command-line build setting applies to every target in the build, so the profile name has to stay behind its own setting per target: the app reads `$(JETBRIDGE_PROFILE_APP)` and an extension with `"bundleIdSuffix": "uploadwidget"` reads `$(JETBRIDGE_PROFILE_UPLOADWIDGET)`. Pointing both at `PROVISIONING_PROFILE_SPECIFIER` directly would give both targets the same profile.

## 5. Reduced variant entitlements

Skip this if your app declares no entitlements. If it does, read it: this is the most common reason a variant fails to sign.

### Why a second file is needed

A variant build registers a new bundle id and mints a profile for it through the public App Store Connect API. That API cannot grant every capability. App groups and Sign in with Apple are the two that come up first: they cannot be enabled through it, so the generated profile does not carry them.

Signing checks the entitlements file against the profile. An entitlement in the file that the profile does not carry fails the build. Your shipping entitlements file is therefore correct for a plain build and wrong for a variant.

The fix is a second file with those entitlements removed, used only for a variant.

### Making the copy

1. Copy the target's entitlements file beside the original, e.g. `Acme/Acme.variant.entitlements`.
2. Remove every entitlement the App Store Connect API cannot grant. In practice: `com.apple.security.application-groups`, `com.apple.developer.applesignin`, and anything else your team enabled by hand in the developer portal rather than through the API.
3. Keep the rest. `aps-environment` for push stays: jetbridge reads this file and enables `PUSH_NOTIFICATIONS` on the registered bundle id for you.
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
    },
  ],
}
```

Both paths are relative to the project root and must stay inside it.

There is no capability list to keep in step. jetbridge reads `variantEntitlements` — the shipping `entitlements` file when there is no variant one — and enables the matching App Store Connect capabilities on the registered bundle id. `aps-environment` becomes `PUSH_NOTIFICATIONS`, `com.apple.developer.associated-domains` becomes `ASSOCIATED_DOMAINS`, and so on. An entitlement it does not recognise is skipped, because Apple adds entitlements faster than any table can follow. A target with no entitlements file asks for no capabilities, which is right for an app that needs none.

This is also why the reduced file is the one it reads: asking the public API for a capability it cannot grant fails the run, and the reduced file is exactly the list of what it can.

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

# 2. Build and launch. The simulator is the default, so this needs nothing.
jetbridge install
```

Stop here until that works. Then add the xcconfig wiring from step 4, and check it with a variant — still no credentials, still nothing signed:

```sh
# 3. The variant should install beside the plain app, with its own label.
jetbridge install --suffix wave
```

Two icons on the simulator home screen means the wiring is right. A launch failure means the suffix is not reaching `PRODUCT_BUNDLE_IDENTIFIER`.

Only then set up credentials — the README covers this — and go to the phone:

```sh
# 4. Build and install the plain app over the cable. Still no credentials needed.
jetbridge install --device

# 5. Register the bundle id, mint a profile, and install the variant.
jetbridge install --device --suffix wave
```

When the phone is not on your desk, the same variant goes out as a link instead:

```sh
# 6. Archive, upload, and print a URL someone else can open.
jetbridge link --suffix wave
```

If any of these fails, [troubleshooting.md](./troubleshooting.md) is organised by the message you actually see.

### What each step proves

| Step                                  | Needs a key | What a pass tells you                                        |
| ------------------------------------- | ----------- | ------------------------------------------------------------ |
| `jetbridge install`                   | no          | the scheme, the configuration and the build are right        |
| `jetbridge install --suffix`          | no          | the xcconfig wiring resolves the suffix                      |
| `jetbridge install --device`          | no          | the phone is reachable and the plain build signs             |
| `jetbridge install --device --suffix` | **yes**     | registration, provisioning and the entitlement swap all work |
| `jetbridge link --suffix`             | **yes**     | the archive, the bucket and the public URL all work          |

A variant on a real device refuses before it builds anything when this machine has no credentials:

```
a variant build has to register a new bundle id, which needs App Store Connect credentials.
  Drop the variant to build the plain bundle id instead.
```

A variant on the **simulator** never hits that check, which is what makes step 3 possible on a machine that has never been near the developer account.

## 8. Over-the-air delivery

`jetbridge link` archives the build, uploads it to a bucket you own, and prints a URL someone else opens on their phone. It is opt-in: `jetbridge init` asks whether you want it, or `init --ota` takes it non-interactively with the `--ota-bucket`, `--ota-region`, `--ota-endpoint` and `--ota-public-base-url` flags.

The bucket credentials are referenced, never stored. Like every credential in this file, they are `${VAR}` references to the environment, so the config holds no secret and stays safe to commit:

```jsonc
"ota": {
  "storage": {
    "bucket": "acme-builds",
    "publicBaseUrl": "https://builds.example.com",
    "accessKeyId": "${JETBRIDGE_S3_ACCESS_KEY_ID}",
    "secretAccessKey": "${JETBRIDGE_S3_SECRET_ACCESS_KEY}",
  },
}
```

Those two are the defaults, so you only write them to point at variables you already use. A bare `"JETBRIDGE_S3_ACCESS_KEY_ID"` is rejected — it reads as either a variable name or the key itself, and this file is committed.

Before it writes anything, `init` uploads a small test object, fetches it back over the public base URL and deletes it. A bucket that accepts uploads but does not serve them publicly is the common misconfiguration, and this is where it costs ten seconds instead of a fifteen-minute archive.

### How install URLs are protected

`init` asks this too, because it decides who can reach a build. Both answers are real; the right one depends on what is already in front of your bucket. `--ota-access <path|none>` sets it non-interactively.

**`path`** — the default. Every key carries an unguessable segment, so someone at the bucket root finds nothing to browse. The URL itself is the secret. That is the only shape that fits the constraint iOS imposes: the phone fetches the manifest and the `.ipa` with no auth header, and a presigned URL would expire inside a page that is meant to stay bookmarkable for weeks.

**`none`** — short, stable, readable URLs, with no extra segment. Right when the bucket is already private and fronted by something that authenticates, or when the builds are simply not sensitive. You give up URL-as-secret and get links that are easy to read, share and keep.

Either way, `ota.storage.prefix` still applies, and neither answer changes what is uploaded — only what the key, and therefore the URL, looks like.

## 9. Running jetbridge unattended

From a script, from CI, or from a coding agent, the rule is the same: nothing prompts if you supply the answers as flags, and no environment variable has to be set to make that true. jetbridge treats a pipe exactly like `CI=1` — neither is required, and neither changes what a command does.

Only two commands ever ask anything, and both take a flag instead:

```sh
# init is the only interactive command. --yes accepts every detected value.
jetbridge init --yes --team-id ABCDE12345 --bundle-id io.acme.app.dev

# Anything destructive prints its plan and stops. -y executes it.
jetbridge bundles prune -y
```

`init --yes` never guesses. Whatever it could not read out of the project is a hard failure naming the flag that supplies it, so a wrong config is never written silently:

```
these could not be worked out from the project, and there is nobody to ask:
  project.teamId — pass --team-id
```

Every other command — `install`, `link`, `reindex`, `bundles ls`, `bundles provision` — asks nothing at all.

Add `--json` to any command to read the result instead of the prose. Machine output goes to **stdout** and every human line to **stderr**, so one caller parses while a person watches:

```sh
jetbridge install --device --json 2>/dev/null | jq -c 'select(.event == "done")'
```

`bundles ls --json` is the exception: it prints one array, the shape it always had. `ls` is the default subcommand, so a bare `jetbridge bundles` lists too. The event stream is described in the README.

Two more flags matter when a script has to be explicit rather than rely on the config:

```sh
jetbridge install --configuration Debug     # the Xcode build configuration
jetbridge --config-file ./ci/jetbridge.config.json install   # which config file to read
```
