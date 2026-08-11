# jetbridge

## 0.1.0-rc.1

### Patch Changes

- [`6f6c3f6`](https://github.com/panofm/jetbridge/commit/6f6c3f6a81a0fc042ccab451e3a0a7bc9a08ea70) Thanks [@adamazad](https://github.com/adamazad)! - Reads `.env.local` and `.env` from the project root, so App Store Connect credentials no longer have to be exported by hand before every command.

  Git worktrees are handled too: a worktree has its own root but no `.env.local` — the file lives only in the main checkout and is git-ignored, so it never propagates. Without the fallback, every build from a worktree looked credential-less on a machine that was configured correctly.

  A file never overwrites a variable that is already set, so exporting one still wins.
