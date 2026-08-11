import { describe, expect, it } from 'vitest';
import {
  branchSuffix,
  currentBranch,
  gitStamp,
  onDefaultBranch,
  requireCleanDefaultBranch,
  stampSetting,
} from '../src/git.js';
import { projectFrom } from '../src/project.js';
import { fakeBoundary } from './helpers/fake-boundary.js';
import { testConfig } from './helpers/config.js';

const project = (overrides: Record<string, unknown> = {}) =>
  projectFrom('/w/jetbridge.config.json', testConfig(overrides));

const withBranch = (branch: string, extra: Parameters<typeof fakeBoundary>[0] = {}) =>
  fakeBoundary({
    commands: [{ match: ['git', 'rev-parse', '--abbrev-ref'], stdout: `${branch}\n` }],
    ...extra,
  });

describe('currentBranch', () => {
  it('reads the checked-out branch', () => {
    expect(currentBranch(withBranch('feat/wave'), '/w')).toBe('feat/wave');
  });

  it('is empty outside a git checkout rather than throwing', () => {
    const boundary = fakeBoundary({
      commands: [{ match: ['git', 'rev-parse'], code: 128, stderr: 'not a git repository' }],
    });
    expect(currentBranch(boundary, '/w')).toBe('');
  });

  it('is empty on a detached HEAD', () => {
    expect(currentBranch(withBranch('HEAD'), '/w')).toBe('');
  });
});

describe('onDefaultBranch', () => {
  it('compares against the configured default branch, not a hardcoded one', () => {
    expect(onDefaultBranch(withBranch('main'), project())).toBe(true);
    expect(onDefaultBranch(withBranch('trunk'), project())).toBe(false);
    expect(onDefaultBranch(withBranch('trunk'), project({ git: { defaultBranch: 'trunk' } }))).toBe(
      true,
    );
    expect(
      onDefaultBranch(withBranch('master'), project({ git: { defaultBranch: 'master' } })),
    ).toBe(true);
  });
});

describe('branchSuffix', () => {
  it('names the variant after the branch', () => {
    expect(branchSuffix(withBranch('feat/seeded-feed'), project())).toBe('feat/seeded-feed');
  });

  it('says what to pass when there is no branch', () => {
    const boundary = fakeBoundary({
      commands: [{ match: ['git', 'rev-parse'], code: 128 }],
    });
    expect(() => branchSuffix(boundary, project())).toThrow(/--suffix wave/);
  });
});

describe('gitStamp', () => {
  const stampBoundary = (sha: string, status: string) =>
    fakeBoundary({
      commands: [
        { match: ['git', 'rev-parse', 'HEAD'], stdout: `${sha}\n` },
        { match: ['git', 'status', '--porcelain'], stdout: status },
      ],
    });

  it('reports the short SHA and a clean tree', () => {
    expect(gitStamp(stampBoundary('abcdef1234567890', ''), '/w')).toEqual({
      sha: 'abcdef1234567890',
      shortSha: 'abcdef1',
      dirty: false,
    });
  });

  it('reports a dirty tree when tracked files are modified', () => {
    expect(gitStamp(stampBoundary('abcdef1234567890', ' M src/a.ts\n'), '/w')?.dirty).toBe(true);
  });

  it('ignores untracked files, which cannot reach the binary', () => {
    const boundary = stampBoundary('abcdef1234567890', '');
    gitStamp(boundary, '/w');
    expect(boundary.commandLines()).toContain('git status --porcelain --untracked-files=no');
  });

  it('returns null outside a git checkout', () => {
    expect(gitStamp(fakeBoundary({ commands: [{ match: ['git'], code: 128 }] }), '/w')).toBeNull();
  });
});

describe('requireCleanDefaultBranch', () => {
  const gated = project({ git: { requireCleanDefaultBranch: true } });

  const boundaryFor = (options: {
    head: string;
    origin: string;
    status?: string;
    fetchOk?: boolean;
  }) =>
    fakeBoundary({
      commands: [
        { match: ['git', 'rev-parse', 'HEAD'], stdout: `${options.head}\n` },
        { match: ['git', 'rev-parse', 'origin/main'], stdout: `${options.origin}\n` },
        { match: ['git', 'status', '--porcelain'], stdout: options.status ?? '' },
        { match: ['git', 'fetch'], code: options.fetchOk === false ? 1 : 0 },
      ],
    });

  it('is skipped for a variant, whose whole point is a branch build', async () => {
    const boundary = boundaryFor({ head: 'aaa1111', origin: 'bbb2222' });
    await expect(requireCleanDefaultBranch(boundary, gated, 'wave')).resolves.toMatchObject({
      shortSha: 'aaa1111',
    });
    expect(boundary.findCall('git', 'fetch')).toBeUndefined();
  });

  it('is off unless the project asks for it', async () => {
    const boundary = boundaryFor({ head: 'aaa1111', origin: 'bbb2222' });
    await expect(requireCleanDefaultBranch(boundary, project(), '')).resolves.not.toBeNull();
    expect(boundary.findCall('git', 'fetch')).toBeUndefined();
  });

  it('passes when HEAD matches the remote default branch and the tree is clean', async () => {
    const boundary = boundaryFor({ head: 'aaa1111', origin: 'aaa1111' });
    await expect(requireCleanDefaultBranch(boundary, gated, '')).resolves.toMatchObject({
      dirty: false,
    });
  });

  it('refuses when HEAD is not the remote default branch, and says both SHAs', async () => {
    const boundary = boundaryFor({ head: 'aaa1111', origin: 'bbb2222' });
    await expect(requireCleanDefaultBranch(boundary, gated, '')).rejects.toThrow(
      /HEAD is aaa1111, origin\/main is bbb2222/,
    );
  });

  it('refuses a dirty tree even when the SHA matches', async () => {
    const boundary = boundaryFor({ head: 'aaa1111', origin: 'aaa1111', status: ' M a.ts' });
    await expect(requireCleanDefaultBranch(boundary, gated, '')).rejects.toThrow(
      /uncommitted changes to tracked files/,
    );
  });

  it('points at the variant escape hatch rather than just refusing', async () => {
    const boundary = boundaryFor({ head: 'aaa1111', origin: 'bbb2222' });
    await expect(requireCleanDefaultBranch(boundary, gated, '')).rejects.toThrow(/--suffix/);
  });

  it('survives being offline by comparing against the local ref', async () => {
    const boundary = boundaryFor({ head: 'aaa1111', origin: 'aaa1111', fetchOk: false });
    await expect(requireCleanDefaultBranch(boundary, gated, '')).resolves.not.toBeNull();
  });

  it('uses the configured default branch throughout', async () => {
    const trunk = project({ git: { requireCleanDefaultBranch: true, defaultBranch: 'trunk' } });
    const boundary = fakeBoundary({
      commands: [
        { match: ['git', 'rev-parse', 'HEAD'], stdout: 'aaa1111\n' },
        { match: ['git', 'rev-parse', 'origin/trunk'], stdout: 'aaa1111\n' },
        { match: ['git', 'status'], stdout: '' },
        { match: ['git', 'fetch'], code: 0 },
      ],
    });
    await expect(requireCleanDefaultBranch(boundary, trunk, '')).resolves.not.toBeNull();
    expect(boundary.commandLines()).toContain('git fetch origin trunk --quiet');
  });
});

describe('stampSetting', () => {
  const config = testConfig();

  it('is the short SHA for a clean tree', () => {
    expect(stampSetting({ sha: 'abcdef1234', shortSha: 'abcdef1', dirty: false }, config)).toBe(
      'abcdef1',
    );
  });

  it('marks a dirty tree, so a build that does not match its SHA says so', () => {
    expect(stampSetting({ sha: 'abcdef1234', shortSha: 'abcdef1', dirty: true }, config)).toBe(
      'abcdef1-dirty',
    );
  });

  it('is undefined outside a git checkout', () => {
    expect(stampSetting(null, config)).toBeUndefined();
  });
});
