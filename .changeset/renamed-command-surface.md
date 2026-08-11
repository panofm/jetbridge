---
'jetbridge': minor
---

Renamed the command surface so each command says where a build goes.

`install` takes the destination as a flag, the way Flutter, React Native and EAS all do, and defaults to the simulator because that route needs no credentials, no signing and no paired hardware. `link` produces a link someone else opens. `bundles` is a noun-first group in the shape of `docker image ls/rm/prune`, so the noun carries the meaning a bare verb could not.

- `jetbridge install` / `install --device` / `install --simulator`
- `jetbridge link`
- `jetbridge bundles ls | provision | rm | prune`
- `-c, --configuration` replaces `-c, --config`, which sat one keystroke from `--config-file`

Every command now runs unattended without setting `CI=1`. Behind a pipe the non-interactive path is automatic, no command prompts when there is nobody to ask, and a child process can no longer inherit an open stdin and hang forever.
