# Credentials

Registering a variant bundle id and minting a provisioning profile happen through the App Store Connect API, so jetbridge needs an API key. You make one once, per team.

## Which commands need one

| Command                               | Needs a key | Why                                              |
| ------------------------------------- | ----------- | ------------------------------------------------ |
| `jetbridge install`                   | no          | a simulator validates no signature at all        |
| `jetbridge install --suffix`          | no          | same — a variant on the simulator signs nothing  |
| `jetbridge install --device`          | no          | signs against a profile you already have         |
| `jetbridge install --device --suffix` | **yes**     | a new bundle id has to be registered             |
| `jetbridge link`                      | **yes**     | archives against a generated Ad Hoc profile      |
| `jetbridge bundles …`                 | **yes**     | reads and removes state in the developer account |

## 1. Create the key

In [App Store Connect](https://appstoreconnect.apple.com) → **Users and Access** → **Integrations** → **App Store Connect API** → **Team Keys**, select **+**.

Give it a name you will recognise later (`jetbridge`), and grant the **App Manager** role. Admin works too.

**Developer is not enough.** It cannot register a new bundle id, and the failure arrives as a bare `403 FORBIDDEN_ERROR` with nothing in it about roles.

It also has to be a **Team Key**, not an Individual Key — individual keys cannot manage bundle ids or profiles.

## 2. Download the `.p8`, once

Apple lets you download the private key **exactly once**. Lose it and the only remedy is to revoke the key and make another.

Note the two identifiers on the same page:

- **Key ID** — ten characters, also in the filename Apple gives you.
- **Issuer ID** — a UUID at the top of the page, shared by every key on the team.

## 3. Put the key where jetbridge looks

Keep the filename Apple gave you:

```sh
mkdir -p ~/.appstoreconnect/private_keys
mv ~/Downloads/AuthKey_ABCD123456.p8 ~/.appstoreconnect/private_keys/
```

That is the last of four directories Apple's own tools search, and jetbridge searches the same four in the same order:

```
./private_keys
~/private_keys
~/.private_keys
~/.appstoreconnect/private_keys
```

Anywhere else, point `ASC_API_KEY_PATH` at the file directly.

## 4. Export the identifiers

```sh
export ASC_API_KEY_ID=ABCD123456
export ASC_API_ISSUER_ID=69a6de70-0000-0000-0000-000000000000
```

Put them wherever your project already keeps local environment variables. The config file **references** the environment and never holds a value, so it is safe to commit and the key never is.

Rename the variables if your project prefers, using the `${VAR}` form:

```jsonc
"credentials": {
  "ascKeyId": "${MY_ASC_KEY_ID}",
  "ascIssuerId": "${MY_ASC_ISSUER_ID}"
}
```

The `${...}` is required, and a bare name is rejected:

```
credentials.ascKeyId: must reference an environment variable as "${VAR}" — never the value itself
```

That is the point of the shape. `"ascKeyId": "ABCD123456"` reads as either a variable name or the key id itself, and this file gets committed — so the ambiguity is removed rather than guessed at. It is the same convention as docker-compose, GitHub Actions and VS Code.

Note which form goes where. The config carries `${ASC_API_KEY_ID}`; your shell exports the bare `ASC_API_KEY_ID`. When a variable does not resolve, jetbridge names the bare one, because that is what you have to export.

The same rule covers the bucket credentials, `ota.storage.accessKeyId` and `ota.storage.secretAccessKey`.

## 5. Register your device

A profile can only install on devices registered to the team. The simplest way to register one is to plug it in and build to it once from Xcode. After that jetbridge picks it up automatically, because every profile it mints covers every enabled device on the team.

An unregistered device is one of the two most common over-the-air failures — iOS says only "Unable to install", with no hint that the device is missing from the profile.

## Keeping the key safe

The `.p8` is a credential for your whole developer account.

- Never commit it, never put it in the config file, never paste it into a CI log.
- In CI, hold it as a secret and write it to disk at the start of the job.
- If it leaks, revoke it in App Store Connect immediately. Revoking is instant; a replacement takes a minute.
