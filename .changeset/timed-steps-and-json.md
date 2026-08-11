---
'jetbridge': minor
---

Every command now reports what it is doing while it does it. The app, its bundle id and its configuration, the devices, and the profiles that will sign the build are printed BEFORE anything slow starts — so a wrong `--suffix` costs a second instead of a full build — and each slow phase is a timed step that announces itself and rewrites its own line when it finishes. Nothing is silent for minutes, and the build number is reported with where the same number appears on the phone. Without a terminal, each step prints one plain line and no escape codes.

`--json` on any command puts newline-delimited events on **stdout**, one object per line, while every human line stays on **stderr** — so a script can pipe stdout to a parser while a person watches the run. Events cover the start, the resolved devices, the signing decision and which profiles it used, each step with its duration in milliseconds, each per-device install, the `link` URLs, and a final `done` with the total and an `ok` flag. A failure emits `error` and then `done` with `"ok": false`, and the exit code stays non-zero. `bundles ls --json` keeps its existing array output unchanged.

Build hook output is captured rather than inherited, and quoted on failure — a hook that printed its own banner used to repeat the line the runner had just drawn.

Everything a step prints from inside itself — one line per profile provisioned — is now indented under that step instead of landing on its half-drawn line, and the step column is sized to the run's own labels so one long device name cannot push every other duration out of alignment. Progress lines are no longer dropped without a terminal: a redirected log now carries every one of them, in order, with no escape codes.
