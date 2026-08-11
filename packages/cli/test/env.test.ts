/**
 * Env loading exists for one reason: credentials live in a git-ignored
 * `.env.local`, and a worktree does not have one. Both halves are asserted
 * here, because losing either makes a correctly configured machine look
 * credential-less.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeBoundary } from '../src/boundary.js';
import { ENV_FILENAMES, loadEnv, mainCheckoutOf } from '../src/env.js';
import { fakeBoundary } from './helpers/fake-boundary.js';

/** Names this suite sets, cleared between tests so nothing leaks. */
const TOUCHED = ['JB_ONE', 'JB_TWO', 'JB_ALREADY', 'JB_FROM_MAIN'];

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jetbridge-env-'));
  for (const name of TOUCHED) delete process.env[name];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const name of TOUCHED) delete process.env[name];
});

const boundary = () => nodeBoundary();

describe('loadEnv', () => {
  it('reads .env.local from the project root', () => {
    writeFileSync(join(root, '.env.local'), 'JB_ONE=from-local\n');
    const loaded = loadEnv(boundary(), root);
    expect(process.env.JB_ONE).toBe('from-local');
    expect(loaded.names).toContain('JB_ONE');
  });

  it('reads .env as well, with .env.local winning', () => {
    writeFileSync(join(root, '.env'), 'JB_ONE=from-env\nJB_TWO=only-in-env\n');
    writeFileSync(join(root, '.env.local'), 'JB_ONE=from-local\n');
    loadEnv(boundary(), root);
    expect(process.env.JB_ONE).toBe('from-local');
    expect(process.env.JB_TWO).toBe('only-in-env');
  });

  it('never overwrites a variable that is already set', () => {
    // Otherwise exporting a variable to fix something would silently do
    // nothing, which is the worst kind of configuration bug.
    process.env.JB_ALREADY = 'from-environment';
    writeFileSync(join(root, '.env.local'), 'JB_ALREADY=from-file\n');
    loadEnv(boundary(), root);
    expect(process.env.JB_ALREADY).toBe('from-environment');
  });

  it('does nothing when there is no env file', () => {
    const loaded = loadEnv(boundary(), root);
    expect(loaded.files).toEqual([]);
    expect(loaded.names).toEqual([]);
  });

  it('checks the documented filenames in order', () => {
    expect([...ENV_FILENAMES]).toEqual(['.env.local', '.env']);
  });
});

describe('the worktree fallback', () => {
  /**
   * A worktree has its own root and no `.env.local` — the file lives only in
   * the main checkout and is git-ignored, so it never propagates. Without this
   * fallback every build from a worktree looks credential-less.
   */
  it('falls back to the main checkout when the worktree has no env file', () => {
    const main = join(root, 'main');
    const worktree = join(root, 'wt-feature');
    mkdirSync(main, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(main, '.env.local'), 'JB_FROM_MAIN=yes\n');

    const fake = fakeBoundary({
      cwd: worktree,
      files: { [join(main, '.env.local')]: 'JB_FROM_MAIN=yes\n' },
      commands: [{ match: ['git', 'rev-parse', '--git-common-dir'], stdout: `${main}/.git\n` }],
    });
    const loaded = loadEnv(fake, worktree);
    expect(loaded.files).toEqual([join(main, '.env.local')]);
    expect(process.env.JB_FROM_MAIN).toBe('yes');
  });

  it('prefers the worktree’s own file when it has one', () => {
    const main = join(root, 'main');
    const worktree = join(root, 'wt-feature');
    const fake = fakeBoundary({
      cwd: worktree,
      files: {
        [join(worktree, '.env.local')]: 'JB_ONE=from-worktree\n',
        [join(main, '.env.local')]: 'JB_ONE=from-main\n',
      },
      commands: [{ match: ['git', 'rev-parse', '--git-common-dir'], stdout: `${main}/.git\n` }],
    });
    const loaded = loadEnv(fake, worktree);
    expect(loaded.files[0]).toBe(join(worktree, '.env.local'));
    expect(process.env.JB_ONE).toBe('from-worktree');
  });
});

describe('mainCheckoutOf', () => {
  it('resolves a relative --git-common-dir against the checkout', () => {
    // git prints `.git` from inside the repository root, not an absolute path.
    const fake = fakeBoundary({
      commands: [{ match: ['git', 'rev-parse', '--git-common-dir'], stdout: '.git\n' }],
    });
    expect(mainCheckoutOf(fake, '/w/project')).toBeNull();
  });

  it('returns the main checkout for a worktree', () => {
    const fake = fakeBoundary({
      commands: [{ match: ['git', 'rev-parse', '--git-common-dir'], stdout: '/w/main/.git\n' }],
    });
    expect(mainCheckoutOf(fake, '/w/wt-feature')).toBe('/w/main');
  });

  it('is null outside a git checkout', () => {
    const fake = fakeBoundary({ commands: [{ match: ['git'], code: 128 }] });
    expect(mainCheckoutOf(fake, '/w/project')).toBeNull();
  });
});
