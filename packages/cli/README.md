# jetbridge

Build, sign and deliver iOS dev builds — to a simulator, down a cable, or over the air to your own bucket.

One config file, one command per destination, and no service in the middle: the `.ipa` goes to a bucket you own, and the phone installs from a link.

```sh
npm install --save-dev jetbridge
```

**Contents** — [Quick start](#quick-start) · [Commands](#commands) · [Variants](#variants) · [Configuration](#configuration) · [Credentials](#credentials) · [Unattended runs](#unattended-runs) · [JSON output](#json-output) · [Guides](#guides)

## Quick start

```sh
npx jetbridge init        # writes jetbridge.config.json by reading your Xcode project
npx jetbridge install     # builds and launches on a simulator
```

Start there deliberately: a simulator validates no code signature, so that second command needs no Apple credentials, no provisioning and no paired phone. Once it works, add [credentials](#credentials) and move to a real device.

```sh
npx jetbridge install --device     # over the cable
npx jetbridge link                 # upload, and print a link anyone can install from
```

## Commands

| Command                       | What it does                                      | Needs Apple credentials |
| ----------------------------- | ------------------------------------------------- | ----------------------- |
| `jetbridge init`              | write the config by inspecting your Xcode project | no                      |
| `jetbridge install`           | build and launch on a simulator                   | no                      |
| `jetbridge install --device`  | build and install over the cable                  | only with `--suffix`    |
| `jetbridge link`              | archive, upload, print an install link            | yes                     |
| `jetbridge bundles ls`        | what this project has registered with Apple       | yes                     |
| `jetbridge bundles provision` | refresh profiles without building                 | yes                     |
| `jetbridge bundles rm <slug>` | remove named variants                             | yes                     |
| `jetbridge bundles prune`     | remove variants whose git branch is gone          | yes                     |
| `jetbridge reindex`           | rebuild the build index page from the bucket      | no                      |

The destination is a flag, not a separate command: `--device` means the cable, and `--device "Dev's iPhone"` means that one phone. Same for `--simulator`.

Deleting anything is a dry run by default — `bundles rm` and `bundles prune` print the plan and stop until you pass `-y`. Apple restores nothing.

## Variants

Two branches installing dev builds overwrite each other, because both carry the same bundle id. A variant gives a branch its own bundle id and its own home-screen label, so both apps sit side by side and stay distinguishable.

```sh
jetbridge install --device --suffix seeded-feed
  → io.acme.app.dev.seededfeed, home-screen "Acme Seeded Feed"

jetbridge install --device --suffix
  → the same, named after the current git branch
```

Every variant registers a bundle id and a profile with Apple, permanently. `jetbridge bundles prune` clears out the ones whose branch has since been merged or deleted.

## Configuration

`jetbridge.config.json` sits at the root of your project, and `jetbridge init` writes it for you. Editors autocomplete it from the `$schema` key.

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

Nothing secret belongs in this file: credentials are referenced by environment variable **name**, never by value, so the config is safe to commit.

Your project also has to consume a few build settings that jetbridge passes on the command line — appending the variant suffix to the bundle id, and pointing at the generated profile. Those lines, and the reduced entitlements a variant needs, are in **[Adopting jetbridge](docs/adopting.md)**.

## Credentials

Registering a variant bundle id or minting a profile goes through the App Store Connect API, so those commands need an API key with the **App Manager** role. `install` on a simulator needs nothing, and a plain `install --device` signs against a profile you already have.

```sh
export ASC_API_KEY_ID=ABCD123456
export ASC_API_ISSUER_ID=69a6de70-0000-0000-0000-000000000000
# key file at ~/.appstoreconnect/private_keys/AuthKey_ABCD123456.p8
```

Making the key, where to put it, which role fails and why, and registering your device: **[Credentials](docs/credentials.md)**.

## Unattended runs

Every command works with nobody watching — a script, a pipe, CI, or an AI agent. **You never need to set `CI=1`.**

No terminal means no questions: jetbridge falls back to the flag-driven path and, where an answer is genuinely required, fails immediately naming the flag that supplies it. It never waits for input it cannot receive, because a command that hangs prints nothing at all.

```sh
jetbridge init --yes --scheme Acme --team-id ABCDE12345 | cat
```

`--yes` supplies consent: to writing the config, and to a deletion in `bundles rm` / `bundles prune`. If you are on a terminal and want the unattended path anyway, `CI=1` and `JETBRIDGE_NON_INTERACTIVE=1` both force it — neither is ever required.

## JSON output

Every command takes `--json`. Machine output goes to **stdout**, one JSON object per line; every human line goes to **stderr**. So a script parses stdout while a person still watches the run.

```sh
jetbridge install --device --json | jq -c 'select(.event == "step" and .phase == "end")'
```

```jsonc
{"event":"start","command":"install","destination":"device","bundleId":"io.acme.app.dev.wave","displayName":"Acme Wave","configuration":"Debug","suffix":"wave"}
{"event":"devices","devices":[{"id":"10BFE051","name":"Dev's 17 Pro","udid":"…","transport":"wired"}]}
{"event":"signing","decision":"cached","profiles":["Acme wave app","Acme wave uploadwidget"]}
{"event":"step","step":"build","phase":"start"}
{"event":"step","step":"build","phase":"end","ok":true,"durationMs":72000,"buildNumber":"1786437647","configuration":"Debug"}
{"event":"step","step":"install","phase":"end","ok":true,"durationMs":18000,"device":{"id":"10BFE051","name":"Dev's 17 Pro"},"bundleId":"io.acme.app.dev.wave"}
{"event":"done","ok":true,"durationMs":113000,"devices":1,"bundleId":"io.acme.app.dev.wave"}
```

Every object has an `event`. `start` names the run, `devices` and `signing` carry the header facts, each `step` appears twice (`phase` `start` then `end`, the second with `durationMs` and `ok`), and `done` closes the stream with `ok` and the total. `jetbridge link` adds `link`, with the install, index and manifest URLs. A failure emits `error` with the message, then `done` with `"ok":false`, and the exit code is non-zero — so a reader can loop until `done` and never hang.

Every command opens with `start` and closes with `done`, so a reader can loop until `done` and never hang. `init` and `reindex` carry no header rows and add one event of their own (`init`, `reindex`) before closing.

`bundles ls --json` is the one exception: it prints a single array of variants, the shape it always had, and nothing else — no `start`, no `done`. Read it with `JSON.parse` on the whole stream, not line by line.

Without `--json`, stdout carries only a command's own payload (the `bundles ls` table); the progress you read while it runs is stderr either way. On a terminal a step rewrites its own line as it finishes; redirected to a file, each step prints one plain line and no escape codes.

## Guides

- **[Adopting jetbridge](docs/adopting.md)** — an existing app from nothing to a working variant install: what `init` infers, the xcconfig wiring, reduced entitlements, extensions.
- **[Credentials](docs/credentials.md)** — creating the App Store Connect key, where it lives, registering devices.
- **[Troubleshooting](docs/troubleshooting.md)** — organised by the symptom you see, because the visible error rarely names the cause.
- **[Releasing](docs/releasing.md)** — how a change reaches npm.

## Requirements

- macOS with Xcode and its command line tools
- Node 20 or newer
- An Apple Developer account, for anything that signs for a device

## License

MIT
