# jetbridge

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
