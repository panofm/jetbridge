# Troubleshooting

Organised by the symptom you see, because the visible error rarely names the cause. iOS in particular reports most delivery failures as one of two strings, neither of which says anything useful.

New to the tool? [adopting.md](./adopting.md) is the setup path. The [README](../README.md) covers credentials.

## The phone says "Unable to install"

**You see** — you open the install link in Safari, iOS asks to install, and then a dialog says only "Unable to install". No status, no reason.

**What is wrong** — the device is not in the Ad Hoc provisioning profile the `.ipa` was signed with. A profile can only install on devices registered to the team, and the profile jetbridge mints covers every device that is _enabled on the team at the time it was minted_. A phone registered after that is not in it.

**The fix**

1. Register the device once: plug it in and build to it from Xcode. That adds it to the team.
2. Re-run the OTA build. Every profile jetbridge mints covers every enabled device on the team, so the new phone is included from then on.

If the device was already registered before the build, check it is _enabled_ in the developer portal. jetbridge asks Apple only for enabled devices, and refuses to build against an empty list:

```
no enabled iOS devices are registered on this team, so a profile would install nowhere.
  Register the device once (plug it in and build from Xcode), then re-run.
```

## The phone says "Cannot connect to <host>"

**You see** — Safari opens the install link and fails immediately with "Cannot connect", naming the host. The upload succeeded and the file is in the bucket.

**What is wrong** — one of two things, and iOS distinguishes neither:

- the bucket does not serve the object publicly, so the manifest fetch returns 403; or
- the URL is not HTTPS with a certificate iOS trusts.

**Why you should not see this** — jetbridge fetches the manifest itself before it prints any URL, and fails with the real status:

```
the manifest is not reachable: HTTP 403 on <url>.
  Likely cause: the bucket policy on "acme-builds" does not allow public reads of this prefix.
  Grant s3:GetObject on "builds/*" to everyone (never s3:ListBucket), then
  re-run. iOS reports this failure only as "Cannot connect", so it is checked here instead.
```

A 404 in that message means something different: the object is not at that URL, so `ota.storage.publicBaseUrl` or the prefix does not match how the bucket is served.

**The fix** — the bucket policy needs exactly one thing: `s3:GetObject` on the prefix, for everyone. Never `s3:ListBucket` — that turns the bucket into a directory listing of every build you have ever made, and the install URLs are meant to be unguessable.

HTTPS is not optional and is not a preference of this tool. `itms-services` refuses anything else, so the config schema rejects an `http://` base URL before it can reach a phone:

```
must be https:// — iOS refuses to install over http
```

If your bucket is served over a CDN, `publicBaseUrl` is the CDN host, not the bucket host.

## `403 FORBIDDEN_ERROR` when a variant is registered

**You see** — a variant build stops at the first App Store Connect call:

```
could not register the bundle id io.acme.app.dev.wave: 403 FORBIDDEN_ERROR
```

**What is wrong** — the API key has the **Developer** role. Developer cannot register a bundle id. Nothing in Apple's response mentions roles.

**The fix** — the key needs **App Manager** or **Admin**. Roles cannot be changed after a key is made, so make a new key in App Store Connect → Users and Access → Integrations → App Store Connect API, grant App Manager, and download the new `.p8`. It must be a **Team** key: an Individual key cannot manage bundle ids or profiles at all.

The same 403 on a key that used to work usually means the key was revoked, or it belongs to a team you have left. `jetbridge clean` phrases that case directly:

```
could not list bundle ids (HTTP 403).
  Check that the App Store Connect key still has access to this team.
```

## The build installs, but the app launches the old code

**You see** — the install reports success, you open the app, and it is the previous build. Nothing suggests the install did not happen.

**What is wrong** — the build number did not change. iOS treats "this `CFBundleVersion` is already installed" as nothing to do. It skips the install silently.

jetbridge passes a fresh `CURRENT_PROJECT_VERSION` on every single run, derived from the clock, precisely to stop this. If you still see it, your project's `CFBundleVersion` does not come from `CURRENT_PROJECT_VERSION`.

**The fix**

- If the project generates its Info.plist (`GENERATE_INFOPLIST_FILE = YES`), `CFBundleVersion` follows `CURRENT_PROJECT_VERSION` already. Check nothing overrides it with a literal.
- If the project has a checked-in Info.plist, the value must be the substitution, not a number:

  ```xml
  <key>CFBundleVersion</key>
  <string>$(CURRENT_PROJECT_VERSION)</string>
  ```

To confirm what actually reached the phone, delete the app and install again. If the fresh install has your change, the build number is the problem.

## The app installed beside the one you expected — or overwrote it

**You see** — two icons where you wanted one, or one icon where you wanted two.

**What is wrong** — the bundle id resolved to something other than what you had in mind. A build's identity is its bundle id, and nothing else. Two rules decide it:

- **No `--suffix`** — the plain `project.baseBundleId`. This is the app every branch shares. Installing it overwrites whatever was there.
- **`--suffix <slug>`** — `<baseBundleId>.<slug>`, where the slug is reduced to lowercase letters and digits.

The slug is not the string you typed. Separators are removed and leading noise words are dropped, so a branch name works as-is:

```
--suffix feat/seeded-feed   →  io.acme.app.dev.seededfeed   "Acme Seeded Feed"
--suffix seeded-feed        →  the same
--suffix wave               →  io.acme.app.dev.wave         "Acme Wave"
```

The dropped words are conventional-commit types (`feat`, `fix`, `chore`, …) and the segments of your base bundle id. A slug that is _only_ a noise word is kept, so `--suffix fix` still names the variant `fix`.

**Two apps where you wanted one** — you ran once with `--suffix` and once without, or with two slugs that reduce differently. Every install prints what it produced:

```
installed io.acme.app.dev.wave ("Acme Wave") → Dev's iPhone
```

**One app where you wanted two** — the suffix never reached the build. The most likely cause is the missing xcconfig wiring: without `PRODUCT_BUNDLE_IDENTIFIER = io.acme.app.dev$(JETBRIDGE_BUNDLE_SUFFIX)`, jetbridge passes the suffix and the project ignores it. See [adopting.md, step 4](./adopting.md#4-the-xcconfig-wiring).

**A pasted bundle id** is refused rather than flattened:

```
a variant slug is just the last segment — "io.acme.app.dev.<slug>" is built for you (e.g. "wave")
```

## A variant fails at the code-signing step

**You see** — the build compiles and fails while signing, with Xcode naming an entitlement that the provisioning profile does not carry.

**What is wrong** — almost always: the build signed against the **full** entitlements file rather than the reduced variant one. App groups and Sign in with Apple cannot be granted through the public App Store Connect API, so the profile jetbridge mints does not carry them, and an entitlements file that asks for them cannot be signed against it.

**The fix** — declare the reduced file, so the swap can happen. Both keys are required; a target with only `entitlements` is never swapped:

```jsonc
{
  "name": "Acme",
  "entitlements": "ios/Acme/Acme.entitlements",
  "variantEntitlements": "ios/Acme/Acme.variant.entitlements",
}
```

[adopting.md, step 5](./adopting.md#5-reduced-variant-entitlements) covers what to remove from the copy.

If the swap is declared but the path is spelled differently from the way the project spells it, jetbridge stops before building:

```
the entitlement swap matched no CODE_SIGN_ENTITLEMENTS in the project file.
  Check that variant.targets[].entitlements matches the path the project spells,
  and regenerate the project if it is stale.
```

Copy the path out of `project.pbxproj` exactly. If the project is generated from a spec, regenerate it first — a stale project file spells the old path.

## No device is found

**You see** — one of two messages, and they mean different things.

**Nothing is paired at all:**

```
`devicectl list devices` failed — is a device paired?
  Pair one in Xcode (Window › Devices and Simulators), then re-run.
```

Pair the phone once in Xcode. Trust the computer on the phone when it asks.

**Paired, but nothing is reachable:**

```
no paired device is reachable — plug one in, or join it to this Mac's Wi-Fi.
  (`jetbridge ota` needs no device at all)
```

A device counts as reachable when it is paired **and** reports a transport — a cable, or the local network. A phone that is paired but asleep in a drawer has no transport.

**Named a specific device that is paired but unreachable:**

```
Dev's iPhone is paired but has no transport — plug it in, or join it to Wi-Fi.
```

Two things that are not the problem:

- **The debug tunnel.** A cabled iPhone reporting `wired` with a disconnected tunnel installs fine. The tunnel is opened on demand by the install itself.
- **Wi-Fi.** A Wi-Fi device is a valid target, just a slow one. jetbridge says so rather than letting it read as a hang:
  ```
  over Wi-Fi (slower): Dev's iPhone — cable them for the fast loop
  ```

Every run prints the full paired list with each device's transport before it selects anything. `--device` accepts the identifier, the name, the UDID or the serial number.

Also check `project.deviceTypes` in the config. It defaults to `["iPhone"]`, and a paired iPad is filtered out before any of the above runs — deliberately, because `devicectl` reports an iPad's platform as `iOS` too.

## The project file is left with a variant entitlement swap

**You see** — `git status` shows `project.pbxproj` modified, and the next variant build refuses to start:

```
<path>/project.pbxproj still carries a variant entitlement swap from an interrupted run.
  Restore it first (`git checkout -- <path>`), then re-run.
```

**What is wrong** — a run was killed with `SIGKILL`, or the machine lost power, while the reduced entitlements were patched in. `SIGKILL` cannot be caught, so nothing could restore the file.

**The fix** — restore it, exactly as the message says:

```sh
git checkout -- ios/Acme.xcodeproj/project.pbxproj
```

This check exists because the project file is tracked. Without it, a later `git add -A` would quietly commit the reduced entitlements, and every build after that would sign against them with nobody asking for a variant.

`SIGINT`, `SIGTERM` and `SIGHUP` are all handled, so Ctrl-C and a `kill` from another shell both restore the file. Only `SIGKILL` and a power cut can strand it.

## A variant will not sign after a certificate rotation

**You see** — signing fails after you made a new development certificate, or after moving to a different Mac.

**What is wrong** — probably not the profile cache. jetbridge keeps installed profiles and skips provisioning when they are still good, but a cached profile only counts when **all** of these hold:

- its name is the one the provisioner mints, for every target;
- it is more than a day from expiring;
- it covers every device this install targets;
- it embeds a certificate whose private key is in _this_ keychain.

That last condition is what makes a certificate rotation invalidate the cache by itself. Any error while checking — an unreadable profile, a `security` hiccup — also counts as a miss, and a miss provisions fresh. When the cache is used, it says so:

```
signing: cached profiles already cover these devices — skipping provisioning
```

**The fix** — if signing still fails, bypass the cache:

```sh
jetbridge wired --suffix wave --reprovision
```

That deletes and recreates the profile with the current certificate and the current device list. If it fails too, the certificate is the problem rather than the cache:

```
no App Store Connect development certificate matches a signing identity in this keychain.
  Create one in Xcode once (Settings › Accounts › Manage Certificates), or import the
  existing certificate's private key into this keychain.
```

A certificate in your Apple account whose private key is on another Mac cannot sign here. Either make a certificate on this machine, or export the key from the machine that has it.

## Other messages

**A build configuration that does not exist**

```
"Staging" is not one of this project's build configurations (Debug, Release)
```

`configurations.available` lists what the project has. Re-run `jetbridge init` to refresh it — the repair pass reports exactly this kind of drift and updates only the fields you accept.

**The export produced no `.ipa`**

```
the export produced no .ipa in <path>.
  Check that ota.exportMethod matches a certificate this machine holds.
```

`ota.exportMethod` is `ad-hoc` by default. `enterprise` needs an Enterprise account and a distribution certificate to match.

**A dirty working tree during an OTA build**

```
the working tree is dirty — this .ipa matches no commit
```

A warning, not a failure. The build is fine; its provenance is not, because the stamped commit does not describe the code that was built.

**A plain install refused on a branch** — only when `git.requireCleanDefaultBranch` is on:

```
a plain install must build exactly origin/main — HEAD is a1b2c3d, origin/main is 9f8e7d6.
  The plain app is shared by every branch, so a branch or dirty build makes its
  vintage unknowable on the phone. Either merge first and install from main,
  or install this branch beside it as its own app with --suffix.
```

Do what the last line says: install the branch as its own app with `--suffix`. That is what variants are for.

**`jetbridge clean` deleted nothing**

Deletion is irreversible and Apple restores nothing, so a dry run is the default:

```
dry run — nothing was deleted. Re-run with --yes to remove 3 variant(s).
```

It also refuses to touch your base bundle id or the ids of extensions that ship in the plain build, whatever you name:

```
refusing to delete io.acme.app.dev — it is a core identifier, not a variant.
```
