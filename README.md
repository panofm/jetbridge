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
