# jetbridge

Build, sign and deliver iOS dev builds — to a simulator, down a cable, or over the air to your own bucket.

One config file, one command per delivery route, and no CI service in the middle: the `.ipa` goes to a bucket you own and the phone installs from a link.

```
jetbridge init             # write jetbridge.config.json by inspecting your Xcode project
jetbridge sim              # build and launch on a simulator
jetbridge wired            # build and install over the cable
jetbridge ota              # archive, upload, print an install URL
jetbridge clean            # remove variant bundle ids from your developer account
```

## Variants: two branches, two apps

The problem this solves: two people (or two branches) installing dev builds overwrite each other, because both builds carry the same bundle id. A variant gives a branch its own bundle id and its own home-screen label, so both apps sit side by side and stay distinguishable.

```
jetbridge wired --suffix seeded-feed
  → io.acme.app.dev.seededfeed, home-screen "Acme Seeded Feed"

jetbridge wired --suffix
  → the same, named after the current git branch
```

Registering a new bundle id needs App Store Connect API credentials. A simulator validates no signature at all, so `jetbridge sim --suffix` needs nothing.

## Over the air

`jetbridge ota` archives, exports an Ad Hoc `.ipa`, uploads it to any S3-compatible bucket (AWS, R2, MinIO, Backblaze) and prints an `itms-services://` URL. A rolling index page lists recent builds.

Two things iOS insists on, and jetbridge checks before printing a URL rather than letting you find out on the phone:

1. **HTTPS with a valid certificate**, for both the manifest and the `.ipa`. A `http://` base URL is rejected by the config schema.
2. **The device must be in the Ad Hoc profile.** An unregistered phone gets "Unable to install" with no explanation.

A bucket that is not publicly readable returns 403, and iOS reports only "Cannot connect" — so the manifest is fetched once, before the URL is shown, and the failure names the bucket policy.

## App Store Connect credentials

Registering a variant bundle id and minting a provisioning profile happens through the App Store Connect API, so jetbridge needs an API key. You make one once, per team.

Not every command needs it:

| Command                    | Needs a key | Why                                              |
| -------------------------- | ----------- | ------------------------------------------------ |
| `jetbridge sim`            | no          | a simulator validates no signature at all        |
| `jetbridge sim --suffix`   | no          | same — a variant on the simulator signs nothing  |
| `jetbridge wired`          | no          | signs against a profile you already have         |
| `jetbridge wired --suffix` | **yes**     | a new bundle id has to be registered             |
| `jetbridge ota`            | **yes**     | archives against a generated Ad Hoc profile      |
| `jetbridge clean`          | **yes**     | removes bundle ids and profiles from the account |

### 1. Create the key

In [App Store Connect](https://appstoreconnect.apple.com) → **Users and Access** → **Integrations** → **App Store Connect API** → **Team Keys**, select **+**.

Give it a name you will recognise later (`jetbridge`), and grant the **App Manager** role. Admin works too. **Developer is not enough** — it cannot register a new bundle id, and the failure arrives as a bare `403 FORBIDDEN_ERROR` with nothing about roles in it.

You need a key of the **Team Keys** kind, not an Individual Key: individual keys cannot manage bundle ids or profiles.

### 2. Download the `.p8`, once

Apple lets you download the private key **exactly once**. Lose it and the only remedy is to revoke the key and make another.

Note the two identifiers on the same page:

- **Key ID** — ten characters, also in the filename Apple gives you.
- **Issuer ID** — a UUID at the top of the page, shared by every key on the team.

### 3. Put the key where jetbridge looks

Use the filename Apple gave you, unchanged:

```sh
mkdir -p ~/.appstoreconnect/private_keys
mv ~/Downloads/AuthKey_ABCD123456.p8 ~/.appstoreconnect/private_keys/
```

That directory is the last of the four Apple's own tools search, and jetbridge searches the same four in the same order:

```
./private_keys
~/private_keys
~/.private_keys
~/.appstoreconnect/private_keys
```

Anywhere else, point `ASC_API_KEY_PATH` at the file directly.

### 4. Export the identifiers

```sh
export ASC_API_KEY_ID=ABCD123456
export ASC_API_ISSUER_ID=69a6de70-0000-0000-0000-000000000000
```

Put them in whatever your project already uses for local environment variables. The config file stores only these **variable names**, never their values, so the config is safe to commit and the key never is.

Rename the variables if your project prefers different ones:

```jsonc
"credentials": {
  "ascKeyId": "MY_ASC_KEY_ID",
  "ascIssuerId": "MY_ASC_ISSUER_ID"
}
```

### 5. Register your device

A profile can only install on devices registered to the team. The simplest way to register one is to plug it in and build to it once from Xcode; after that jetbridge picks it up automatically, because every profile it mints covers every enabled device on the team.

An unregistered device is the second most common OTA failure — iOS says only "Unable to install", with no hint that the device is missing from the profile.

### Keeping the key safe

The `.p8` is a credential for your whole developer account. Never commit it, never put it in the config file, and never paste it into a CI log. For CI, hold it as a secret and write it to disk at the start of the job. If it leaks, revoke it in App Store Connect immediately — revoking is instant and making a replacement takes a minute.

## Configuration

`jetbridge.config.json` lives at the root of your project. `jetbridge init` writes it for you by reading your Xcode project; the whole file is documented by its JSON Schema, which editors pick up from the `$schema` key.

```jsonc
{
  "$schema": "https://unpkg.com/jetbridge/schema/v1.json",
  "configVersion": 1,

  "project": {
    "iosDir": "ios",
    "xcodeproj": "Acme.xcodeproj",
    "scheme": "Acme",
    "teamId": "ABCDE12345",
    "baseBundleId": "io.acme.app.dev",
  },

  "configurations": {
    "available": ["Debug", "Release"],
    "wired": "Debug",
    "archive": "Release",
  },

  "variant": {
    "displayName": "Acme Dev",
    "targets": [
      { "name": "Acme", "capabilities": ["PUSH_NOTIFICATIONS"] },
      { "name": "UploadWidget", "bundleIdSuffix": "uploadwidget" },
    ],
  },

  "ota": {
    "storage": {
      "bucket": "acme-builds",
      "region": "eu-central-1",
      "publicBaseUrl": "https://builds.example.com",
    },
  },
}
```

Credentials are referenced by **environment variable name**, never by value — nothing secret belongs in this file.

`teamId` is your ten-character Apple team id, on the [Membership details](https://developer.apple.com/account) page — the same value Xcode shows as **Team ID**. `jetbridge init` reads it out of your project when the project already sets `DEVELOPMENT_TEAM`.

### What your project has to do

jetbridge passes a few build settings on the xcodebuild command line; your xcconfig decides what they mean. The names are configurable, and these are the defaults:

| Setting                   | Value                      | Use it for                            |
| ------------------------- | -------------------------- | ------------------------------------- |
| `JETBRIDGE_BUNDLE_SUFFIX` | `.seededfeed`              | append to `PRODUCT_BUNDLE_IDENTIFIER` |
| `JETBRIDGE_DISPLAY_NAME`  | `Acme Seeded Feed`         | `INFOPLIST_KEY_CFBundleDisplayName`   |
| `JETBRIDGE_SIGN_STYLE`    | `Manual` for a variant     | `CODE_SIGN_STYLE`                     |
| `JETBRIDGE_PROFILE_APP`   | the generated profile name | `PROVISIONING_PROFILE_SPECIFIER`      |

### Hooks

`hooks.preBuild` and `hooks.postBuild` are shell commands run in the project root — the escape hatch for whatever your project does before a build that jetbridge should not know about. JSON cannot hold a function; shell strings are the deliberate cost of a config file a wizard can write and a person can read.

## Requirements

- macOS with Xcode and its command line tools
- Node 20 or newer
- An Apple Developer account, for anything that signs for a device

## License

MIT
