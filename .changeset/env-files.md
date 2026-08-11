---
'jetbridge': patch
---

Reads `.env.local` and `.env` from the project root, so App Store Connect credentials no longer have to be exported by hand before every command.

Git worktrees are handled too: a worktree has its own root but no `.env.local` — the file lives only in the main checkout and is git-ignored, so it never propagates. Without the fallback, every build from a worktree looked credential-less on a machine that was configured correctly.

A file never overwrites a variable that is already set, so exporting one still wins.
