/**
 * Reading `.env` files, so credentials do not have to be exported by hand.
 *
 * The App Store Connect key id and issuer id live in whatever a project
 * already uses for local environment variables — almost always a git-ignored
 * `.env.local`. A tool that reads only `process.env` makes every invocation
 * `set -a; . .env.local; …`, which people forget, and the failure it produces
 * is "credentials not configured" on a machine where they plainly are.
 *
 * The git-worktree case is the one that actually bites. A worktree has its own
 * root but no `.env.local` — the file exists only in the main checkout, and is
 * git-ignored so it never propagates. Without the fallback below, every build
 * from a worktree looks credential-less.
 */
import { parse as parseEnv } from 'dotenv';
import { dirname, join, resolve } from 'node:path';
import type { Boundary } from './boundary.js';

/** Checked in order; the first value found for a name wins. */
export const ENV_FILENAMES = ['.env.local', '.env'] as const;

export interface LoadedEnv {
  /** Files actually read, in the order they were applied. */
  files: string[];
  /** Names set from a file. A name already in the environment is never replaced. */
  names: string[];
}

/**
 * The main checkout behind a worktree, or null.
 *
 * `--git-common-dir` may print a path relative to the checkout, so it is
 * resolved before use. Its parent is the main working tree.
 */
export function mainCheckoutOf(boundary: Boundary, root: string): string | null {
  const result = boundary.exec.runSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: root,
    allowFail: true,
  });
  if (!result.ok) return null;
  const commonDir = resolve(root, result.stdout.trim());
  const main = dirname(commonDir);
  return main === root ? null : main;
}

/**
 * Load env files for a project, without overwriting anything already set —
 * an explicitly exported variable, or one from CI, always wins over a file.
 */
export function loadEnv(boundary: Boundary, root: string): LoadedEnv {
  const directories = [root];
  const main = mainCheckoutOf(boundary, root);
  if (main) directories.push(main);

  const files: string[] = [];
  const names = new Set<string>();

  for (const directory of directories) {
    for (const filename of ENV_FILENAMES) {
      const path = join(directory, filename);
      if (!boundary.fs.exists(path)) continue;

      // Read through the boundary and parse the string, rather than letting
      // dotenv touch the filesystem itself: everything this tool reads goes
      // through one place, and that is what makes it testable.
      const parsed = parseEnv(boundary.fs.read(path));
      files.push(path);
      for (const [name, value] of Object.entries(parsed)) {
        // A file must never beat the real environment, or exporting a variable
        // to fix something would silently do nothing.
        if (name in process.env) continue;
        process.env[name] = value;
        names.add(name);
      }
    }
  }

  return { files, names: [...names] };
}
