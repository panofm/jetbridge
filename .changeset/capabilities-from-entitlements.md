---
'jetbridge': minor
---

Capabilities come from the entitlements file. **Breaking config change.**

`variant.targets[].capabilities` is gone. Delete it — a config that still carries it is not an error, the key is ignored. jetbridge now reads the target's `variantEntitlements` file (the `entitlements` file when there is no variant one) and enables the App Store Connect capabilities its keys imply: `aps-environment` → `PUSH_NOTIFICATIONS`, `com.apple.developer.associated-domains` → `ASSOCIATED_DOMAINS`, `com.apple.security.application-groups` → `APP_GROUPS`, and thirteen more.

A hand-kept list drifts from the file it is supposed to describe: the config says `PUSH_NOTIFICATIONS`, someone edits the entitlements, and nothing notices until a build signs against a profile missing a capability. The entitlements file already states the same facts, so it is now the only place that states them.

Notes on what changes for a project that upgrades:

- A target with no entitlements file asks for no capabilities. That is the common case and it is fine.
- The reduced `variantEntitlements` file is preferred deliberately. It is where a project drops what the public API cannot grant, so deriving from the shipping file would ask Apple for capabilities it refuses.
- An entitlement key jetbridge does not recognise is skipped. Apple adds entitlements constantly and an unknown one must never fail a build.
- An entitlements file that is declared but not on disk yields no capabilities; one that is on disk and does not parse fails the run.
- If a target has only a shipping `entitlements` file that declares app groups or Sign in with Apple, jetbridge now asks App Store Connect to enable them where a hand-written empty `capabilities` list previously asked for nothing. Give that target a `variantEntitlements` file with those keys removed — which is what a variant build needs anyway.
