/**
 * Reading the files that ship beside the code.
 *
 * The HTML templates are package assets, not project files, so they are read
 * here rather than through the boundary. Resolving them from
 * `import.meta.dirname` would work in source and break once tsup bundles
 * `src/*.ts` into `dist/` — the chunk's directory is not the package root, and
 * `templates/` sits next to it, not under it. So the package root is found the
 * only way that survives bundling: walk up until `package.json` appears.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedRoot: string | undefined;

/** The directory holding this package's `package.json`. */
export function packageRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `could not find the jetbridge package root above ${dirname(fileURLToPath(import.meta.url))}.\n` +
          '  Reinstall the package — its templates/ directory is missing.',
      );
    }
    dir = parent;
  }
}

export function templatePath(name: string): string {
  return join(packageRoot(), 'templates', name);
}

export function readTemplate(name: string): string {
  const path = templatePath(name);
  if (!existsSync(path)) {
    throw new Error(`missing template ${path} — reinstall jetbridge, its assets are incomplete`);
  }
  return readFileSync(path, 'utf8');
}

/**
 * Substitute `{{TOKEN}}` placeholders and refuse to emit a page that still has
 * one. A renamed placeholder is then a loud failure instead of literal braces
 * on a page someone is about to install from.
 *
 * Function replacements, because a string replacement interprets `$&` and `$1`
 * in the REPLACEMENT — and a branch name is allowed to contain them.
 */
export function fillTemplate(template: string, values: Record<string, string>): string {
  let page = template;
  for (const [key, value] of Object.entries(values)) {
    page = page.replaceAll(`{{${key}}}`, () => value);
  }
  const missing = [...new Set(page.match(/\{\{[A-Z_]+\}\}/g) ?? [])];
  if (missing.length > 0) {
    throw new Error(
      `the template has unsubstituted placeholders: ${missing.join(', ')}.\n` +
        '  Every {{TOKEN}} needs a value — pass it, or drop it from the template.',
    );
  }
  return page;
}
