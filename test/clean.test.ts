/**
 * Cleaning deletes from a real developer account and Apple restores nothing, so
 * every claim here is asserted against a fake: what the dry run does NOT send,
 * the order the deletes go out in, and the refusal to touch the base bundle id.
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertDeletable,
  cleanVariants,
  groupVariants,
  protectedBundleIds,
  type RegisteredBundleId,
  type RegisteredProfile,
} from '../src/clean.js';
import { projectFrom } from '../src/project.js';
import { fakeBoundary, type FakeBoundary, type StubbedRequest } from './helpers/fake-boundary.js';
import { testConfig } from './helpers/config.js';

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
  bundle('ROW-TIDE', 'io.acme.app.dev.tide', 'Acme Tide'),
  bundle('ROW-OTHER', 'io.other.app', 'Someone Else'),
];

const ACCOUNT_PROFILES: RegisteredProfile[] = [
  { id: 'PROF-WAVE-APP', name: 'Acme wave app' },
  { id: 'PROF-WAVE-WIDGET', name: 'Acme wave uploadwidget' },
  { id: 'PROF-TIDE-APP', name: 'Acme tide app' },
  { id: 'PROF-UNRELATED', name: 'Acme Dev Manual' },
];

const asAscRows = (rows: Array<{ id: string; [key: string]: unknown }>) => ({
  data: rows.map(({ id, ...attributes }) => ({ id, type: 'x', attributes })),
});

/** A boundary with credentials and a stocked account behind the ASC endpoints. */
function accountBoundary(extra: StubbedRequest[] = []): FakeBoundary {
  return fakeBoundary({
    homedir: '/home/dev',
    env: { ASC_API_KEY_ID: 'KEY1', ASC_API_ISSUER_ID: 'ISSUER1' },
    files: { '/home/dev/.appstoreconnect/private_keys/AuthKey_KEY1.p8': KEY_PEM },
    requests: [
      {
        method: 'GET',
        url: '/v1/bundleIds',
        status: 200,
        body: asAscRows(
          ACCOUNT_BUNDLE_IDS.map((b) => ({ id: b.id, identifier: b.identifier, name: b.name })),
        ),
      },
      {
        method: 'GET',
        url: '/v1/profiles',
        status: 200,
        body: asAscRows(ACCOUNT_PROFILES.map((p) => ({ id: p.id, name: p.name }))),
      },
      ...extra,
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

describe('protectedBundleIds', () => {
  it('covers the base id and the extensions the plain build ships', () => {
    expect([...protectedBundleIds(config)]).toEqual([
      'io.acme.app.dev',
      'io.acme.app.dev.uploadwidget',
    ]);
  });
});

describe('assertDeletable', () => {
  it('refuses the base bundle id', () => {
    expect(() => assertDeletable('io.acme.app.dev', config)).toThrow(
      /refusing to delete io\.acme\.app\.dev — it is a core identifier/,
    );
  });

  it("refuses the plain build's extension id", () => {
    expect(() => assertDeletable('io.acme.app.dev.uploadwidget', config)).toThrow(
      /core identifier/,
    );
  });

  it('refuses anything outside this project', () => {
    expect(() => assertDeletable('io.other.app', config)).toThrow(/not a "io\.acme\.app\.dev\.\*"/);
  });

  it('allows a variant and its extension', () => {
    expect(() => assertDeletable('io.acme.app.dev.wave', config)).not.toThrow();
    expect(() => assertDeletable('io.acme.app.dev.wave.uploadwidget', config)).not.toThrow();
  });
});

describe('groupVariants', () => {
  const variants = groupVariants(ACCOUNT_BUNDLE_IDS, ACCOUNT_PROFILES, config);

  it('finds only the variants, sorted', () => {
    expect(variants.map((v) => v.suffix)).toEqual(['tide', 'wave']);
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

describe('cleanVariants', () => {
  it('is a dry run by default: it issues no deletes', async () => {
    const boundary = accountBoundary();
    await cleanVariants(boundary, project, { suffixes: ['wave'] });
    expect(deletePaths(boundary)).toEqual([]);
  });

  it('prints the plan in the dry run', async () => {
    const boundary = accountBoundary();
    const messages: string[] = [];
    boundary.log.info = (m) => messages.push(m);
    boundary.log.warn = (m) => messages.push(m);
    await cleanVariants(boundary, project, { suffixes: ['wave'] });
    const printed = messages.join('\n');
    expect(printed).toContain('io.acme.app.dev.wave');
    expect(printed).toContain('io.acme.app.dev.wave.uploadwidget');
    expect(printed).toContain('profile: Acme wave app');
    expect(printed).toMatch(/dry run/);
  });

  it('deletes profiles, then extensions, then the app id', async () => {
    const boundary = accountBoundary();
    await cleanVariants(boundary, project, { suffixes: ['wave'], yes: true });
    expect(deletePaths(boundary)).toEqual([
      '/v1/profiles/PROF-WAVE-APP',
      '/v1/profiles/PROF-WAVE-WIDGET',
      '/v1/bundleIds/ROW-WAVE-WIDGET',
      '/v1/bundleIds/ROW-WAVE',
    ]);
  });

  it('cleans every variant when asked for all of them', async () => {
    const boundary = accountBoundary();
    await cleanVariants(boundary, project, { all: true, yes: true });
    expect(deletePaths(boundary)).toContain('/v1/bundleIds/ROW-TIDE');
    expect(deletePaths(boundary)).toContain('/v1/bundleIds/ROW-WAVE');
  });

  it('never deletes the base bundle id, even when cleaning everything', async () => {
    const boundary = accountBoundary();
    await cleanVariants(boundary, project, { all: true, yes: true });
    expect(deletePaths(boundary)).not.toContain('/v1/bundleIds/ROW-BASE');
    expect(deletePaths(boundary)).not.toContain('/v1/bundleIds/ROW-BASE-WIDGET');
  });

  it('says which slugs exist when the named one does not', async () => {
    const boundary = accountBoundary();
    await expect(
      cleanVariants(boundary, project, { suffixes: ['nope'], yes: true }),
    ).rejects.toThrow(/no variant "nope" is registered[\s\S]*tide, wave/);
    expect(deletePaths(boundary)).toEqual([]);
  });

  it('refuses to guess when nothing was named', async () => {
    const boundary = accountBoundary();
    await expect(cleanVariants(boundary, project, { yes: true })).rejects.toThrow(
      /name what to remove/,
    );
    expect(deletePaths(boundary)).toEqual([]);
  });

  it('says there is nothing to do on an account with no variants', async () => {
    const boundary = fakeBoundary({
      homedir: '/home/dev',
      env: { ASC_API_KEY_ID: 'KEY1', ASC_API_ISSUER_ID: 'ISSUER1' },
      files: { '/home/dev/.appstoreconnect/private_keys/AuthKey_KEY1.p8': KEY_PEM },
      requests: [
        {
          method: 'GET',
          url: '/v1/bundleIds',
          status: 200,
          body: asAscRows([{ id: 'ROW-BASE', identifier: 'io.acme.app.dev', name: 'Acme Dev' }]),
        },
        { method: 'GET', url: '/v1/profiles', status: 200, body: asAscRows([]) },
      ],
    });
    await cleanVariants(boundary, project, { all: true, yes: true });
    expect(deletePaths(boundary)).toEqual([]);
  });

  it('explains an account it cannot read', async () => {
    const boundary = fakeBoundary({
      homedir: '/home/dev',
      env: { ASC_API_KEY_ID: 'KEY1', ASC_API_ISSUER_ID: 'ISSUER1' },
      files: { '/home/dev/.appstoreconnect/private_keys/AuthKey_KEY1.p8': KEY_PEM },
      requests: [
        { method: 'GET', url: '/v1/bundleIds', status: 401, body: {} },
        { method: 'GET', url: '/v1/profiles', status: 200, body: asAscRows([]) },
      ],
    });
    await expect(cleanVariants(boundary, project, { all: true, yes: true })).rejects.toThrow(
      /could not list bundle ids \(HTTP 401\)/,
    );
  });

  it('requires credentials before touching the network', async () => {
    const boundary = fakeBoundary({ homedir: '/home/dev' });
    await expect(cleanVariants(boundary, project, { all: true, yes: true })).rejects.toThrow(
      /App Store Connect credentials are not configured/,
    );
    expect(boundary.requests).toEqual([]);
  });

  it('stops with a readable error when a bundle id will not delete', async () => {
    const boundary = accountBoundary([
      { method: 'DELETE', url: '/v1/bundleIds/ROW-WAVE-WIDGET', status: 409 },
    ]);
    await expect(
      cleanVariants(boundary, project, { suffixes: ['wave'], yes: true }),
    ).rejects.toThrow(/io\.acme\.app\.dev\.wave\.uploadwidget was not deleted \(HTTP 409\)/);
  });

  it('warns but carries on when a profile will not delete', async () => {
    const boundary = accountBoundary([
      { method: 'DELETE', url: '/v1/profiles/PROF-WAVE-APP', status: 409 },
    ]);
    const warnings: string[] = [];
    boundary.log.warn = (m) => warnings.push(m);
    await cleanVariants(boundary, project, { suffixes: ['wave'], yes: true });
    expect(warnings.join('\n')).toMatch(/profile "Acme wave app" was not deleted/);
    expect(deletePaths(boundary)).toContain('/v1/bundleIds/ROW-WAVE');
  });
});
