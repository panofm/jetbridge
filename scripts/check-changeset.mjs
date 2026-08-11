#!/usr/bin/env node
/**
 * A change to what actually ships must carry a changeset, or it reaches npm
 * unversioned — or never reaches it at all, which is worse because nobody
 * notices for a week.
 *
 * Runs inside CI's existing check job rather than its own: a guard that takes
 * two seconds still bills a whole minute on its own runner.
 */
import { execFileSync } from 'node:child_process';

/** Everything that ends up inside the published tarball. */
const PUBLISHED_PATHS = ['src', 'templates', 'schema', 'package.json', 'README.md'];

const BASE_REF = process.env.CHANGESET_BASE_REF ?? 'origin/main';

const git = (args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};

const names = (args) => (git(args) ?? '').split('\n').filter(Boolean);

/**
 * Prefer the merge base. On a shallow CI clone it may be missing, in which case
 * a two-dot diff is equivalent — a pull_request checkout resolves to the MERGE
 * ref, so HEAD already contains the base branch.
 */
function resolveRange() {
  if (git(['rev-parse', '--verify', BASE_REF]) === null) return null;
  const mergeBase = git(['merge-base', BASE_REF, 'HEAD']);
  return mergeBase ? [`${mergeBase}...HEAD`] : [`${BASE_REF}..HEAD`];
}

const range = resolveRange();
if (range === null) {
  console.warn(
    `check-changeset: could not diff against ${BASE_REF} — is it fetched? ` +
      '(in CI, run `git fetch origin main` first). Skipping.',
  );
  process.exit(0);
}

const published = names(['diff', '--name-only', ...range, '--', ...PUBLISHED_PATHS]);
if (published.length === 0) {
  console.log('check-changeset: OK — nothing publishable changed.');
  process.exit(0);
}

const added = names([
  'diff',
  '--name-only',
  '--diff-filter=A',
  ...range,
  '--',
  '.changeset/*.md',
]).filter((file) => !/README\.md$/.test(file));

if (added.length > 0) {
  console.log(
    `check-changeset: OK — ${published.length} publishable file(s) changed, accompanied by:\n` +
      added.map((file) => `  ${file}`).join('\n'),
  );
  process.exit(0);
}

console.error(
  `check-changeset: ${published.length} publishable file(s) changed with no changeset:\n` +
    published.map((file) => `  ${file}`).join('\n') +
    '\n\nAdd one with `npx changeset`, then commit the generated .changeset/*.md file.\n' +
    'Pick patch for a fix, minor for a feature, major for a breaking change.',
);
process.exit(1);
