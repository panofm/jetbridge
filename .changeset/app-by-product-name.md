---
'jetbridge': patch
---

`install` and `install --device` now find the built app by its product name, not by the scheme's name.

The path was `<scheme>.app`, so a project whose `PRODUCT_NAME` differs from its scheme — scheme `Acme`, app `Wave.app` — failed with "produced no app". Worse, right after such a rename the cached DerivedData still holds the old `<scheme>.app`, and that stale build is what would have installed. jetbridge now asks `xcodebuild -showBuildSettings` for the scheme's one application product after the build, shown as its own step (a few seconds). When xcodebuild cannot answer, it falls back to `<scheme>.app` and says so. `link` was never affected: it reads the app's path out of the archive.
