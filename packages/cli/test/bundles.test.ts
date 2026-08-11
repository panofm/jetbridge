/**
 * These commands delete from a real developer account and Apple restores
 * nothing, so every claim is asserted against a fake: what a dry run does NOT
 * send, the order the deletes go out in, the refusal to touch the base bundle
 * id, and — above all — that an unreachable remote aborts a prune instead of
 * reading as "every branch is gone".
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertDeletable,
  fetchBundleIds,
  firstSeen,
  groupVariants,
  listBundles,
  liveBranchSlugs,
  protectedBundleIds,
  provisionBundles,
  pruneBundles,
  removeBundles,
  renderTable,
  toRecords,
  type RegisteredBundleId,
  type RegisteredProfile,
} from '../src/bundles.js';
import type { ResolvedTarget } from '../src/bundle-ids.js';
import { projectFrom } from '../src/project.js';
import {
  fakeBoundary,
  type FakeBoundary,
  type StubbedCommand,
  type StubbedRequest,
} from './helpers/fake-boundary.js';
import { testConfig } from './helpers/config.js';
import { PROJECT_FILES } from './helpers/pbxproj.js';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const config = testConfig({
  variant: {
    displayName: 'Acme Dev',
    targets: [{ name: 'Acme' }, { name: 'Upload Widget', bundleIdSuffix: 'uploadwidget' }],
  },
});

const project = projectFrom('/w/jetbridge.config.json', config);

const bundle = (id: string, identifier: string, name = identifier): RegisteredBundleId => ({
  id,
  identifier,
  name,
});

/** What a busy account looks like: the real ids, their extensions, two variants. */
const ACCOUNT_BUNDLE_IDS: RegisteredBundleId[] = [
  bundle('ROW-BASE', 'io.acme.app.dev', 'Acme Dev'),
  bundle('ROW-BASE-WIDGET', 'io.acme.app.dev.uploadwidget', 'Acme Dev Upload Widget'),
  bundle('ROW-WAVE', 'io.acme.app.dev.wave', 'Acme Wave'),
  bundle('ROW-WAVE-WIDGET', 'io.acme.app.dev.wave.uploadwidget', 'Acme Wave Upload Widget'),
  bundle('ROW-SEEDEDFEED', 'io.acme.app.dev.seededfeed', 'Acme Seeded Feed'),
  bundle('ROW-OTHER', 'io.other.app', 'Someone Else'),
];

const ACCOUNT_PROFILES: RegisteredProfile[] = [
  { id: 'PROF-WAVE-APP', name: 'Acme wave app', createdDate: '2026-07-02T09:00:00.000+0000' },
  {
    id: 'PROF-WAVE-WIDGET',
    name: 'Acme wave uploadwidget',
    createdDate: '2026-07-04T09:00:00.000+0000',
  },
  {
    id: 'PROF-SEEDEDFEED-APP',
    name: 'Acme seededfeed app',
    createdDate: '2026-08-01T09:00:00.000+0000',
  },
  { id: 'PROF-UNRELATED', name: 'Acme Dev Manual', createdDate: '2026-01-01T09:00:00.000+0000' },
];

const asAscRows = (rows: Array<{ id: string; [key: string]: unknown }>) => ({
  data: rows.map(({ id, ...attributes }) => ({ id, type: 'x', attributes })),
});

/** `git ls-remote --heads origin` output for the given branch names. */
const lsRemote = (branches: string[]): string =>
  branches.map((branch, index) => `${String(index).repeat(40)}\trefs/heads/${branch}`).join('\n');

const IN_REPO: StubbedCommand = {
  match: ['git', 'rev-parse', '--is-inside-work-tree'],
  stdout: 'true\n',
};

interface AccountOptions {
  requests?: StubbedRequest[];
  commands?: StubbedCommand[];
  bundleIds?: RegisteredBundleId[];
  json?: boolean;
}

/** A boundary with credentials and a stocked account behind the ASC endpoints. */
function accountBoundary(options: AccountOptions = {}): FakeBoundary {
  return fakeBoundary({
    homedir: '/home/dev',
    cwd: '/w',
    json: options.json ?? false,
    env: { ASC_API_KEY_ID: 'KEY1', ASC_API_ISSUER_ID: 'ISSUER1' },
    files: {
      ...PROJECT_FILES,
      '/home/dev/.appstoreconnect/private_keys/AuthKey_KEY1.p8': KEY_PEM,
    },
    commands: options.commands ?? [],
    requests: [
      {
        method: 'GET',
        url: '/v1/bundleIds',
        status: 200,
        body: asAscRows(
          (options.bundleIds ?? ACCOUNT_BUNDLE_IDS).map((b) => ({
            id: b.id,
            identifier: b.identifier,
            name: b.name,
          })),
        ),
      },
      {
        method: 'GET',
        url: '/v1/profiles',
        status: 200,
        body: asAscRows(
          ACCOUNT_PROFILES.map((p) => ({
            id: p.id,
            name: p.name,
            createdDate: p.createdDate,
          })),
        ),
      },
      ...(options.requests ?? []),
      // Every delete succeeds unless a test says otherwise.
      { method: 'DELETE', url: '/v1/profiles/', status: 204 },
      { method: 'DELETE', url: '/v1/bundleIds/', status: 204 },
    ],
  });
}

const deletePaths = (boundary: FakeBoundary): string[] =>
  boundary.requests
    .filter((request) => request.method === 'DELETE')
    .map((request) => request.url.replace('https://api.appstoreconnect.apple.com', ''));

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* protections — carried over wholesale, they are the reason this is safe      */
/* -------------------------------------------------------------------------- */

/** The targets as the pbxproj resolves them, which is what the guards read. */
const targets: ResolvedTarget[] = [
  { name: 'Acme' },
  { name: 'Upload Widget', bundleIdSuffix: 'uploadwidget' },
];
const protectedIds = protectedBundleIds(targets, config);

describe('reading every page', () => {
  /**
   * Apple caps a page at 200 and hands back `links.next`. Reading one page
   * looks like it works — an account under the cap is complete, one over it is
   * quietly partial. A real account had more than 200: `prune` classified only
   * the first page, so it deleted less than it reported, and the listing did
   * not shrink when something was removed.
   */
  const page = (ids: string[], next?: string) => ({
    status: 200,
    body: {
      data: ids.map((id) => ({
        id,
        type: 'bundleIds',
        attributes: { identifier: `io.acme.app.dev.${id}`, name: id },
      })),
      ...(next ? { links: { next } } : {}),
    },
  });

  it('follows links.next until there is none', async () => {
    const calls: string[] = [];
    const client = {
      async request(_method: string, path: string) {
        calls.push(path);
        if (path.includes('page=2')) return page(['c']);
        if (path.includes('page=1')) {
          return page(['b'], 'https://api.appstoreconnect.apple.com/v1/bundleIds?page=2');
        }
        return page(['a'], 'https://api.appstoreconnect.apple.com/v1/bundleIds?page=1');
      },
    } as unknown as Parameters<typeof fetchBundleIds>[0];

    const rows = await fetchBundleIds(client);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(calls).toHaveLength(3);
    // The client takes a path; `next` arrives absolute.
    expect(calls[1]).toBe('/v1/bundleIds?page=1');
  });

  it('stops at one page when there is no next link', async () => {
    const calls: string[] = [];
    const client = {
      async request(_method: string, path: string) {
        calls.push(path);
        return page(['only']);
      },
    } as unknown as Parameters<typeof fetchBundleIds>[0];
    expect((await fetchBundleIds(client)).map((r) => r.id)).toEqual(['only']);
    expect(calls).toHaveLength(1);
  });
});

describe('protectedBundleIds', () => {
  it('covers the base id and the extensions the plain build ships', () => {
    expect([...protectedIds]).toEqual(['io.acme.app.dev', 'io.acme.app.dev.uploadwidget']);
  });
});

describe('assertDeletable', () => {
  it('refuses the base bundle id', () => {
    expect(() => assertDeletable('io.acme.app.dev', protectedIds, config)).toThrow(
      /refusing to delete io\.acme\.app\.dev — it is a core identifier/,
    );
  });

  it("refuses the plain build's extension id", () => {
    expect(() => assertDeletable('io.acme.app.dev.uploadwidget', protectedIds, config)).toThrow(
      /core identifier/,
    );
  });

  it('refuses anything outside this project', () => {
    expect(() => assertDeletable('io.other.app', protectedIds, config)).toThrow(
      /not a "io\.acme\.app\.dev\.\*"/,
    );
  });

  it('allows a variant and its extension', () => {
    expect(() => assertDeletable('io.acme.app.dev.wave', protectedIds, config)).not.toThrow();
    expect(() =>
      assertDeletable('io.acme.app.dev.wave.uploadwidget', protectedIds, config),
    ).not.toThrow();
  });
});

describe('groupVariants', () => {
  const variants = groupVariants(ACCOUNT_BUNDLE_IDS, ACCOUNT_PROFILES, config, protectedIds);

  it('finds only the variants, sorted', () => {
    expect(variants.map((v) => v.suffix)).toEqual(['seededfeed', 'wave']);
  });

  it("never treats the plain build's extension as a variant", () => {
    // `io.acme.app.dev.uploadwidget` is a single segment under the base and
    // passes every structural test — the configured suffix is what excludes it.
    expect(variants.some((v) => v.suffix === 'uploadwidget')).toBe(false);
  });

  it("attaches a variant's own extension to it", () => {
    const wave = variants.find((v) => v.suffix === 'wave')!;
    expect(wave.extensions.map((e) => e.identifier)).toEqual(['io.acme.app.dev.wave.uploadwidget']);
  });

  it('attaches the profiles minted for that variant', () => {
    const wave = variants.find((v) => v.suffix === 'wave')!;
    expect(wave.profiles.map((p) => p.id)).toEqual(['PROF-WAVE-APP', 'PROF-WAVE-WIDGET']);
  });

  it('leaves an unrelated profile alone', () => {
    expect(variants.flatMap((v) => v.profiles).map((p) => p.id)).not.toContain('PROF-UNRELATED');
  });

  it('ignores bundle ids belonging to another app', () => {
    expect(variants.some((v) => v.app.identifier === 'io.other.app')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* ls                                                                         */
/* -------------------------------------------------------------------------- */

describe('firstSeen', () => {
  const variants = groupVariants(ACCOUNT_BUNDLE_IDS, ACCOUNT_PROFILES, config, protectedIds);

  it('takes the earliest profile, since Apple does not date a bundle id', () => {
    expect(firstSeen(variants.find((v) => v.suffix === 'wave')!)).toBe('2026-07-02');
  });

  it('has nothing to show when every profile is gone', () => {
    expect(firstSeen({ suffix: 'x', app: bundle('R', 'i'), extensions: [], profiles: [] })).toBe(
      '—',
    );
  });
});

describe('renderTable', () => {
  const variants = groupVariants(ACCOUNT_BUNDLE_IDS, ACCOUNT_PROFILES, config, protectedIds);

  it('aligns the columns', () => {
    expect(renderTable(variants)).toBe(
      [
        'SLUG        BUNDLE ID                   PROFILES  CREATED',
        'seededfeed  io.acme.app.dev.seededfeed  1         2026-08-01',
        'wave        io.acme.app.dev.wave        2         2026-07-02',
      ].join('\n'),
    );
  });

  it('prints the header even with nothing to list', () => {
    expect(renderTable([])).toBe('SLUG  BUNDLE ID  PROFILES  CREATED');
  });

  it('gives one line per variant', () => {
    expect(renderTable(variants).split('\n')).toHaveLength(3);
  });
});

describe('toRecords', () => {
  it('is the shape a script consumes', () => {
    const variants = groupVariants(ACCOUNT_BUNDLE_IDS, ACCOUNT_PROFILES, config, protectedIds);
    expect(toRecords(variants)[1]).toEqual({
      slug: 'wave',
      bundleId: 'io.acme.app.dev.wave',
      name: 'Acme Wave',
      extensions: ['io.acme.app.dev.wave.uploadwidget'],
      profileCount: 2,
      created: '2026-07-02',
    });
  });

  it('reports a missing date as null rather than a dash', () => {
    expect(
      toRecords([{ suffix: 'x', app: bundle('R', 'i'), extensions: [], profiles: [] }])[0]!.created,
    ).toBeNull();
  });
});

describe('listBundles', () => {
  it('returns the table and writes it to stdout', async () => {
    const boundary = accountBoundary();
    const output = await listBundles(boundary, project);
    expect(output).toContain('io.acme.app.dev.wave');
    expect(boundary.stdout.join('')).toBe(`${output}\n`);
  });

  it('emits parseable JSON with --json', async () => {
    const boundary = accountBoundary();
    const parsed = JSON.parse(await listBundles(boundary, project, { json: true })) as Array<{
      slug: string;
    }>;
    expect(parsed.map((row) => row.slug)).toEqual(['seededfeed', 'wave']);
  });

  it('writes the JSON and nothing else to stdout, so a pipe stays parseable', async () => {
    // Not even the run's own events: this payload predates them and scripts
    // parse the whole stream as one array.
    const boundary = accountBoundary({ json: true });
    const output = await listBundles(boundary, project, { json: true });
    expect(boundary.stdout.join('')).toBe(`${output}\n`);
    expect(JSON.parse(boundary.stdout.join(''))).toHaveLength(2);
  });

  it('emits an empty array rather than prose when there is nothing', async () => {
    const boundary = accountBoundary({ bundleIds: [ACCOUNT_BUNDLE_IDS[0]!] });
    expect(await listBundles(boundary, project, { json: true })).toBe('[]');
  });

  it('never deletes anything', async () => {
    const boundary = accountBoundary();
    await listBundles(boundary, project);
    expect(deletePaths(boundary)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* rm                                                                         */
/* -------------------------------------------------------------------------- */

describe('removeBundles', () => {
  it('is a dry run by default: it issues no deletes', async () => {
    const boundary = accountBoundary();
    const result = await removeBundles(boundary, project, { suffixes: ['wave'] });
    expect(deletePaths(boundary)).toEqual([]);
    expect(result).toEqual({ slugs: ['wave'], dryRun: true });
  });

  it('prints the plan and says how to execute it', async () => {
    const boundary = accountBoundary();
    await removeBundles(boundary, project, { suffixes: ['wave'] });
    const printed = boundary.humanOutput();
    expect(printed).toContain('io.acme.app.dev.wave');
    expect(printed).toContain('io.acme.app.dev.wave.uploadwidget');
    expect(printed).toContain('profile: Acme wave app');
    expect(printed).toMatch(/dry run[\s\S]*re-run with -y/i);
  });

  it('deletes profiles, then extensions, then the app id', async () => {
    const boundary = accountBoundary();
    await removeBundles(boundary, project, { suffixes: ['wave'], yes: true });
    expect(deletePaths(boundary)).toEqual([
      '/v1/profiles/PROF-WAVE-APP',
      '/v1/profiles/PROF-WAVE-WIDGET',
      '/v1/bundleIds/ROW-WAVE-WIDGET',
      '/v1/bundleIds/ROW-WAVE',
    ]);
  });

  it('removes several named variants', async () => {
    const boundary = accountBoundary();
    await removeBundles(boundary, project, { suffixes: ['wave', 'seededfeed'], yes: true });
    expect(deletePaths(boundary)).toContain('/v1/bundleIds/ROW-WAVE');
    expect(deletePaths(boundary)).toContain('/v1/bundleIds/ROW-SEEDEDFEED');
  });

  it('never touches the base bundle id or its extension', async () => {
    const boundary = accountBoundary();
    await removeBundles(boundary, project, { suffixes: ['wave', 'seededfeed'], yes: true });
    expect(deletePaths(boundary)).not.toContain('/v1/bundleIds/ROW-BASE');
    expect(deletePaths(boundary)).not.toContain('/v1/bundleIds/ROW-BASE-WIDGET');
  });

  it('says which slugs exist when the named one does not', async () => {
    const boundary = accountBoundary();
    await expect(
      removeBundles(boundary, project, { suffixes: ['nope'], yes: true }),
    ).rejects.toThrow(/no variant "nope" is registered[\s\S]*seededfeed, wave/);
    expect(deletePaths(boundary)).toEqual([]);
  });

  it('refuses to guess when nothing was named', async () => {
    const boundary = accountBoundary();
    await expect(removeBundles(boundary, project, { suffixes: [], yes: true })).rejects.toThrow(
      /name at least one variant[\s\S]*bundles ls/,
    );
    expect(boundary.requests).toEqual([]);
  });

  it('requires credentials before touching the network', async () => {
    const boundary = fakeBoundary({ homedir: '/home/dev' });
    await expect(
      removeBundles(boundary, project, { suffixes: ['wave'], yes: true }),
    ).rejects.toThrow(/App Store Connect credentials are not configured/);
    expect(boundary.requests).toEqual([]);
  });

  it('stops with a readable error when a bundle id will not delete', async () => {
    const boundary = accountBoundary({
      requests: [{ method: 'DELETE', url: '/v1/bundleIds/ROW-WAVE-WIDGET', status: 409 }],
    });
    await expect(
      removeBundles(boundary, project, { suffixes: ['wave'], yes: true }),
    ).rejects.toThrow(/io\.acme\.app\.dev\.wave\.uploadwidget was not deleted \(HTTP 409\)/);
  });

  it('warns but carries on when a profile will not delete', async () => {
    const boundary = accountBoundary({
      requests: [{ method: 'DELETE', url: '/v1/profiles/PROF-WAVE-APP', status: 409 }],
    });
    const warnings: string[] = [];
    boundary.log.warn = (m) => warnings.push(m);
    await removeBundles(boundary, project, { suffixes: ['wave'], yes: true });
    expect(warnings.join('\n')).toMatch(/profile "Acme wave app" was not deleted/);
    expect(deletePaths(boundary)).toContain('/v1/bundleIds/ROW-WAVE');
  });
});

/* -------------------------------------------------------------------------- */
/* prune — the offline abort is the property that matters most                */
/* -------------------------------------------------------------------------- */

describe('liveBranchSlugs', () => {
  it('reads the remote, not the local branch list', async () => {
    const boundary = accountBoundary({
      commands: [IN_REPO, { match: ['git', 'ls-remote'], stdout: lsRemote(['main']) }],
    });
    await liveBranchSlugs(boundary, project);
    expect(boundary.commandLines()).toContain('git ls-remote --heads origin');
  });

  it('runs git in the project root', async () => {
    const boundary = accountBoundary({
      commands: [IN_REPO, { match: ['git', 'ls-remote'], stdout: lsRemote(['main']) }],
    });
    await liveBranchSlugs(boundary, project);
    expect(boundary.findCall('git', 'ls-remote')!.options.cwd).toBe('/w');
  });

  it('collapses two branch spellings onto one slug', async () => {
    const boundary = accountBoundary({
      commands: [
        IN_REPO,
        { match: ['git', 'ls-remote'], stdout: lsRemote(['feat/seeded-feed', 'seeded_feed']) },
      ],
    });
    // `sanitizeSuffix` is lossy in exactly this way, which is why branches are
    // pushed through it rather than slugs being inverted back into branches.
    expect([...(await liveBranchSlugs(boundary, project))]).toEqual(['seededfeed']);
  });

  it('ignores a ref that names no variant', async () => {
    const boundary = accountBoundary({
      commands: [IN_REPO, { match: ['git', 'ls-remote'], stdout: lsRemote(['---', 'main']) }],
    });
    expect([...(await liveBranchSlugs(boundary, project))]).toEqual(['main']);
  });

  it('ABORTS when the remote cannot be reached', async () => {
    const boundary = accountBoundary({
      commands: [
        IN_REPO,
        {
          match: ['git', 'ls-remote'],
          code: 128,
          stderr: 'fatal: unable to access origin: Could not resolve host',
        },
      ],
    });
    await expect(liveBranchSlugs(boundary, project)).rejects.toThrow(
      /could not reach the git remote[\s\S]*Nothing was deleted/,
    );
  });

  it('ABORTS when the remote reports no branches at all', async () => {
    const boundary = accountBoundary({
      commands: [IN_REPO, { match: ['git', 'ls-remote'], stdout: '' }],
    });
    await expect(liveBranchSlugs(boundary, project)).rejects.toThrow(
      /reported no branches at all[\s\S]*Nothing was deleted/,
    );
  });

  it('refuses outside a git checkout and points at rm', async () => {
    const boundary = accountBoundary({
      commands: [{ match: ['git', 'rev-parse'], code: 128, stderr: 'not a git repository' }],
    });
    await expect(liveBranchSlugs(boundary, project)).rejects.toThrow(
      /not a git checkout[\s\S]*bundles rm <slug>/,
    );
  });

  it('refuses when git succeeds but says false', async () => {
    // Inside a `.git` directory, or with GIT_DIR set, the command exits 0.
    const boundary = accountBoundary({
      commands: [{ match: ['git', 'rev-parse'], stdout: 'false\n' }],
    });
    await expect(liveBranchSlugs(boundary, project)).rejects.toThrow(/not a git checkout/);
  });
});

describe('pruneBundles', () => {
  const withBranches = (branches: string[], requests?: StubbedRequest[]) =>
    accountBoundary({
      ...(requests ? { requests } : {}),
      commands: [IN_REPO, { match: ['git', 'ls-remote'], stdout: lsRemote(branches) }],
    });

  it('keeps a variant whose branch still lives', async () => {
    const boundary = withBranches(['main', 'wave', 'feat/seeded-feed']);
    const result = await pruneBundles(boundary, project, { yes: true });
    expect(result.slugs).toEqual([]);
    expect(deletePaths(boundary)).toEqual([]);
  });

  it('matches a variant through the lossy branch spelling', async () => {
    // The account holds `seededfeed`; the live branch is `feat/seeded-feed`.
    const boundary = withBranches(['main', 'feat/seeded-feed']);
    const result = await pruneBundles(boundary, project, { yes: true });
    expect(result.slugs).toEqual(['wave']);
  });

  it('removes a variant whose branch is gone', async () => {
    const boundary = withBranches(['main', 'seededfeed']);
    await pruneBundles(boundary, project, { yes: true });
    expect(deletePaths(boundary)).toEqual([
      '/v1/profiles/PROF-WAVE-APP',
      '/v1/profiles/PROF-WAVE-WIDGET',
      '/v1/bundleIds/ROW-WAVE-WIDGET',
      '/v1/bundleIds/ROW-WAVE',
    ]);
  });

  it('says why each one is stale, and how many were kept', async () => {
    const boundary = withBranches(['main', 'seededfeed']);
    await pruneBundles(boundary, project, { yes: true });
    const printed = boundary.humanOutput();
    expect(printed).toContain('no branch on the remote maps to this slug');
    expect(printed).toContain('2 variant(s) registered, 1 with a branch still on the remote.');
  });

  it('is a dry run by default', async () => {
    const boundary = withBranches(['main']);
    const result = await pruneBundles(boundary, project);
    expect(result).toEqual({ slugs: ['seededfeed', 'wave'], dryRun: true });
    expect(deletePaths(boundary)).toEqual([]);
  });

  it('succeeds quietly when nothing is stale', async () => {
    const boundary = withBranches(['main', 'wave', 'seededfeed']);
    await expect(pruneBundles(boundary, project)).resolves.toEqual({ slugs: [], dryRun: false });
    expect(boundary.humanOutput()).toContain('nothing to prune');
  });

  it('deletes NOTHING when the remote is unreachable', async () => {
    const boundary = accountBoundary({
      commands: [IN_REPO, { match: ['git', 'ls-remote'], code: 128, stderr: 'no network' }],
    });
    await expect(pruneBundles(boundary, project, { yes: true })).rejects.toThrow(
      /could not reach the git remote/,
    );
    expect(deletePaths(boundary)).toEqual([]);
  });

  it('does not even read the account when the remote is unreachable', async () => {
    const boundary = accountBoundary({
      commands: [IN_REPO, { match: ['git', 'ls-remote'], code: 128, stderr: 'no network' }],
    });
    await expect(pruneBundles(boundary, project, { yes: true })).rejects.toThrow(/remote/);
    expect(boundary.requests).toEqual([]);
  });

  it('never prunes the base bundle id, whatever the branches say', async () => {
    const boundary = withBranches(['main']);
    await pruneBundles(boundary, project, { yes: true });
    expect(deletePaths(boundary)).not.toContain('/v1/bundleIds/ROW-BASE');
    expect(deletePaths(boundary)).not.toContain('/v1/bundleIds/ROW-BASE-WIDGET');
  });
});

/* -------------------------------------------------------------------------- */
/* provision                                                                  */
/* -------------------------------------------------------------------------- */

describe('provisionBundles', () => {
  it('refuses without a slug — a plain build has nothing to register', async () => {
    const boundary = accountBoundary();
    await expect(
      provisionBundles(boundary, project, { suffix: '', displayName: 'Acme Dev' }),
    ).rejects.toThrow(/name the variant to provision/);
    expect(boundary.requests).toEqual([]);
  });

  it('registers through the same provisioner a build uses', async () => {
    const boundary = accountBoundary({
      requests: [
        { method: 'GET', url: '/v1/devices', status: 200, body: { data: [] } },
        {
          method: 'GET',
          url: '/v1/certificates',
          status: 200,
          body: { data: [] },
        },
      ],
    });
    // It runs out of road at the certificate lookup with nothing stubbed; the
    // registration it sent on the way is the proof it went through
    // provisionVariant rather than reimplementing registration here.
    await expect(
      provisionBundles(boundary, project, { suffix: 'wave', displayName: 'Acme Wave' }),
    ).rejects.toThrow();
    // The variant is already registered, so `ensureBundleId` looks it up and
    // sends no POST — the lookup itself is the signal.
    expect(boundary.requests.map((request) => request.url)).toContainEqual(
      expect.stringContaining('/v1/bundleIds?filter[identifier]=io.acme.app.dev.wave'),
    );
  });
});
