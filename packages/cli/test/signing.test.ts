/**
 * The signing cache is the fast path around provisioning, so every reason it
 * MISSES is worth a test: a hit on a stale profile produces a build that signs
 * fine and then refuses to install, which is the expensive failure.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ResolvedTarget } from '../src/bundle-ids.js';
import { projectFrom } from '../src/project.js';
import { PBXPROJ, PBXPROJ_PATH } from './helpers/pbxproj.js';
import {
  cachedSigning,
  localSigningThumbprints,
  parseProfilePlist,
  profileSettingName,
  signSettings,
  variantSettings,
} from '../src/signing.js';
import { testConfig } from './helpers/config.js';
import { fakeBoundary, type FakeBoundaryOptions } from './helpers/fake-boundary.js';

const PROFILE_DIR = '/home/dev/Library/MobileDevice/Provisioning Profiles';
const NOW = 1_700_000_000;
const HOUR_MS = 60 * 60 * 1000;

/** DER bytes never get parsed — only hashed — so any stable blob will do. */
const derBase64 = (seed: string): string => Buffer.from(`der-${seed}`).toString('base64');
const sha1Of = (base64: string): string =>
  createHash('sha1').update(Buffer.from(base64, 'base64')).digest('hex').toUpperCase();

interface PlistSpec {
  name?: string;
  expires?: string;
  devices?: string[];
  certificates?: string[];
}

const plist = (spec: PlistSpec): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    spec.name === undefined ? '' : `<key>Name</key>\n<string>${spec.name}</string>`,
    spec.expires === undefined ? '' : `<key>ExpirationDate</key>\n<date>${spec.expires}</date>`,
    '<key>ProvisionedDevices</key>',
    `<array>${(spec.devices ?? []).map((d) => `<string>${d}</string>`).join('')}</array>`,
    '<key>DeveloperCertificates</key>',
    `<array>${(spec.certificates ?? []).map((c) => `<data>\n\t${c}\n\t</data>`).join('')}</array>`,
    '</dict></plist>',
  ]
    .filter(Boolean)
    .join('\n');

const isoIn = (ms: number): string => new Date(NOW * 1000 + ms).toISOString();

/** The targets as the pbxproj resolves them: the app, plus one extension. */
const resolvedTargets: ResolvedTarget[] = [
  { name: 'Acme' },
  { name: 'Upload Widget', bundleIdSuffix: 'uploadwidget' },
];

describe('profileSettingName', () => {
  it('is JETBRIDGE_PROFILE_APP for the app target', () => {
    expect(profileSettingName({ name: 'Acme' })).toBe('JETBRIDGE_PROFILE_APP');
  });

  it('is the uppercased bundle-id segment for an extension', () => {
    expect(profileSettingName({ name: 'Upload Widget', bundleIdSuffix: 'uploadwidget' })).toBe(
      'JETBRIDGE_PROFILE_UPLOADWIDGET',
    );
  });
});

describe('signSettings', () => {
  const profiles = {
    byTarget: { Acme: 'Acme wave app', 'Upload Widget': 'Acme wave uploadwidget' },
  };

  it('is empty without a variant, leaving the project on automatic signing', () => {
    expect(signSettings('', profiles, resolvedTargets)).toEqual([]);
  });

  it('switches to manual signing and names one profile per configured target', () => {
    expect(signSettings('wave', profiles, resolvedTargets)).toEqual([
      'JETBRIDGE_SIGN_STYLE=Manual',
      'JETBRIDGE_PROFILE_APP=Acme wave app',
      'JETBRIDGE_PROFILE_UPLOADWIDGET=Acme wave uploadwidget',
    ]);
  });

  it('skips a target with no profile, but still switches to manual', () => {
    expect(signSettings('wave', { byTarget: { Acme: 'Acme wave app' } }, resolvedTargets)).toEqual([
      'JETBRIDGE_SIGN_STYLE=Manual',
      'JETBRIDGE_PROFILE_APP=Acme wave app',
    ]);
  });
});

describe('variantSettings', () => {
  it('sets the bundle suffix with a leading dot and the display name', () => {
    expect(variantSettings('wave', 'Acme Wave')).toEqual([
      'JETBRIDGE_SUFFIX=.wave',
      'JETBRIDGE_DISPLAY_NAME=Acme Wave',
    ]);
  });

  it('sets only the display name for a plain build', () => {
    expect(variantSettings('', 'Acme Dev')).toEqual(['JETBRIDGE_DISPLAY_NAME=Acme Dev']);
  });

  it('sets nothing when there is neither', () => {
    expect(variantSettings('', '')).toEqual([]);
  });
});

describe('parseProfilePlist', () => {
  it('extracts the name, expiry, devices and certificate thumbprints', () => {
    const certificates = [derBase64('one'), derBase64('two')];
    const parsed = parseProfilePlist(
      plist({
        name: 'Acme wave app',
        expires: '2030-01-02T03:04:05Z',
        devices: ['UDID-A', 'UDID-B'],
        certificates,
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('Acme wave app');
    expect(parsed!.expiresMs).toBe(Date.parse('2030-01-02T03:04:05Z'));
    expect([...parsed!.devices]).toEqual(['UDID-A', 'UDID-B']);
    expect([...parsed!.certificateSha1]).toEqual(certificates.map(sha1Of));
  });

  it('hashes the DER bytes, not the base64 text, and uppercases the digest', () => {
    const parsed = parseProfilePlist(
      plist({ name: 'P', expires: '2030-01-01T00:00:00Z', certificates: [derBase64('one')] }),
    );
    const expected = sha1Of(derBase64('one'));
    expect([...parsed!.certificateSha1]).toEqual([expected]);
    expect(expected).toMatch(/^[0-9A-F]{40}$/);
  });

  it('returns null without a name', () => {
    expect(parseProfilePlist(plist({ expires: '2030-01-01T00:00:00Z' }))).toBeNull();
  });

  it('returns null without an expiry', () => {
    expect(parseProfilePlist(plist({ name: 'Acme wave app' }))).toBeNull();
  });

  it('returns empty sets when the profile lists no devices or certificates', () => {
    const parsed = parseProfilePlist(
      plist({ name: 'Acme wave app', expires: '2030-01-01T00:00:00Z' }),
    );
    expect(parsed!.devices.size).toBe(0);
    expect(parsed!.certificateSha1.size).toBe(0);
  });
});

describe('localSigningThumbprints', () => {
  it('reads the 40-hex thumbprints out of the keychain listing', () => {
    const a = 'A'.repeat(40);
    const b = '0123456789ABCDEF0123456789ABCDEF01234567';
    const boundary = fakeBoundary({
      commands: [
        {
          match: ['security', 'find-identity'],
          stdout:
            `  1) ${a} "Apple Development: Dev Eloper (SKAV8355Y7)"\n` +
            `  2) ${b} "Apple Development: Someone Else (AAAA111111)"\n` +
            '     2 valid identities found\n',
        },
      ],
    });
    expect([...localSigningThumbprints(boundary)]).toEqual([a, b]);
    expect(boundary.commandLines()).toContain('security find-identity -v -p codesigning');
  });

  it('ignores lowercase hex and short runs', () => {
    const boundary = fakeBoundary({
      commands: [
        {
          match: ['security', 'find-identity'],
          stdout: `1) ${'a'.repeat(40)} 2) ${'B'.repeat(39)}`,
        },
      ],
    });
    expect(localSigningThumbprints(boundary).size).toBe(0);
  });

  it('is empty when the keychain holds no identities', () => {
    const boundary = fakeBoundary({
      commands: [{ match: ['security', 'find-identity'], stdout: '     0 valid identities found' }],
    });
    expect(localSigningThumbprints(boundary).size).toBe(0);
  });
});

describe('cachedSigning', () => {
  const CERT = derBase64('local');
  const options = { suffix: 'wave', deviceUdids: ['UDID-A'], now: NOW };

  const goodPlist = (over: Partial<PlistSpec> = {}): string =>
    plist({
      name: 'Acme wave app',
      expires: isoIn(90 * 24 * HOUR_MS),
      devices: ['UDID-A', 'UDID-B'],
      certificates: [CERT],
      ...over,
    });

  /** One app-only variant config, so a single cached profile is a full hit. */
  const project = projectFrom(
    '/w/jetbridge.config.json',
    testConfig({ variant: { targets: [{ name: 'Acme' }] } }),
  );
  /** Two targets, so the extension's segment comes out of the project file. */
  const variantProject = projectFrom(
    '/w/jetbridge.config.json',
    testConfig({ variant: { targets: [{ name: 'Acme' }, { name: 'Upload Widget' }] } }),
  );
  const emptyProject = projectFrom('/w/jetbridge.config.json', testConfig());

  const boundaryWith = (
    profiles: Record<string, string>,
    over: FakeBoundaryOptions = {},
  ): ReturnType<typeof fakeBoundary> =>
    fakeBoundary({
      homedir: '/home/dev',
      files: {
        [`/w/${PBXPROJ_PATH}`]: PBXPROJ,
        ...Object.fromEntries(
          Object.keys(profiles).map((file) => [`${PROFILE_DIR}/${file}`, 'CMS BYTES']),
        ),
      },
      commands: [
        { match: ['security', 'find-identity'], stdout: `1) ${sha1Of(CERT)} "Apple Development"` },
        ...Object.entries(profiles).map(([file, xml]) => ({
          match: ['security', 'cms', `${PROFILE_DIR}/${file}`],
          stdout: xml,
        })),
      ],
      ...over,
    });

  it('hits when a profile covers the name, expiry, devices and certificate', () => {
    const boundary = boundaryWith({ 'app.mobileprovision': goodPlist() });
    expect(cachedSigning(boundary, project, options)).toEqual({
      byTarget: { Acme: 'Acme wave app' },
    });
  });

  it('returns null when the profile directory does not exist', () => {
    const boundary = fakeBoundary({ homedir: '/home/dev' });
    expect(cachedSigning(boundary, project, options)).toBeNull();
    // Nothing is even asked of the keychain.
    expect(boundary.calls).toEqual([]);
  });

  it('returns null when this keychain holds no signing identities', () => {
    const boundary = boundaryWith(
      { 'app.mobileprovision': goodPlist() },
      { commands: [{ match: ['security', 'find-identity'], stdout: '0 valid identities found' }] },
    );
    expect(cachedSigning(boundary, project, options)).toBeNull();
  });

  it('returns null when the config declares no targets', () => {
    const boundary = boundaryWith({ 'app.mobileprovision': goodPlist() });
    expect(cachedSigning(boundary, emptyProject, options)).toBeNull();
  });

  it('returns null when no device was resolved', () => {
    const boundary = boundaryWith({ 'app.mobileprovision': goodPlist() });
    expect(cachedSigning(boundary, project, { ...options, deviceUdids: [] })).toBeNull();
  });

  it('returns null when a resolved device reported a blank UDID', () => {
    // A blank UDID cannot be checked against the profile's device list, so the
    // cache must not claim coverage it has not verified.
    const boundary = boundaryWith({ 'app.mobileprovision': goodPlist() });
    expect(
      cachedSigning(boundary, project, { ...options, deviceUdids: ['UDID-A', ''] }),
    ).toBeNull();
  });

  it('misses when the profile expires within a day', () => {
    const boundary = boundaryWith({
      'app.mobileprovision': goodPlist({ expires: isoIn(23 * HOUR_MS) }),
    });
    expect(cachedSigning(boundary, project, options)).toBeNull();
  });

  it('hits when the profile expires just outside the margin', () => {
    const boundary = boundaryWith({
      'app.mobileprovision': goodPlist({ expires: isoIn(25 * HOUR_MS) }),
    });
    expect(cachedSigning(boundary, project, options)).not.toBeNull();
  });

  it('misses when the expiry date is unparseable', () => {
    const boundary = boundaryWith({ 'app.mobileprovision': goodPlist({ expires: 'never' }) });
    expect(cachedSigning(boundary, project, options)).toBeNull();
  });

  it('misses when the profile does not cover every targeted device', () => {
    const boundary = boundaryWith({ 'app.mobileprovision': goodPlist({ devices: ['UDID-A'] }) });
    expect(
      cachedSigning(boundary, project, { ...options, deviceUdids: ['UDID-A', 'UDID-NEW'] }),
    ).toBeNull();
  });

  it('misses when no embedded certificate is in this keychain', () => {
    // The certificate-rotation hole: the profile is otherwise perfect, but it
    // was minted over a certificate whose private key this Mac does not have.
    const boundary = boundaryWith({
      'app.mobileprovision': goodPlist({ certificates: [derBase64('someone-else')] }),
    });
    expect(cachedSigning(boundary, project, options)).toBeNull();
  });

  it('misses when the profile name is not what the provisioner mints', () => {
    const boundary = boundaryWith({ 'app.mobileprovision': goodPlist({ name: 'Some Other App' }) });
    expect(cachedSigning(boundary, project, options)).toBeNull();
  });

  it('needs a profile for EVERY target, not just the app', () => {
    const boundary = boundaryWith({ 'app.mobileprovision': goodPlist() });
    expect(cachedSigning(boundary, variantProject, options)).toBeNull();
  });

  it('hits when every target has its own profile', () => {
    const boundary = boundaryWith({
      'app.mobileprovision': goodPlist(),
      'widget.mobileprovision': goodPlist({ name: 'Acme wave uploadwidget' }),
    });
    expect(cachedSigning(boundary, variantProject, options)).toEqual({
      byTarget: { Acme: 'Acme wave app', 'Upload Widget': 'Acme wave uploadwidget' },
    });
  });

  it('ignores files that are not profiles, and profiles that fail to decode', () => {
    const boundary = boundaryWith(
      { 'app.mobileprovision': goodPlist() },
      {
        files: {
          [`${PROFILE_DIR}/README.txt`]: 'not a profile',
          [`${PROFILE_DIR}/aaa-broken.mobileprovision`]: 'CMS BYTES',
          [`${PROFILE_DIR}/app.mobileprovision`]: 'CMS BYTES',
        },
        commands: [
          {
            match: ['security', 'find-identity'],
            stdout: `1) ${sha1Of(CERT)} "Apple Development"`,
          },
          { match: ['security', 'cms', `${PROFILE_DIR}/aaa-broken.mobileprovision`], code: 1 },
          { match: ['security', 'cms', `${PROFILE_DIR}/app.mobileprovision`], stdout: goodPlist() },
        ],
      },
    );
    expect(cachedSigning(boundary, project, options)).not.toBeNull();
    expect(boundary.commandLines().some((line) => line.includes('README.txt'))).toBe(false);
    // Sorted first, so the undecodable profile really is reached and skipped
    // before the good one satisfies the cache and ends the loop.
    expect(boundary.commandLines().some((line) => line.includes('aaa-broken'))).toBe(true);
  });

  it('swallows a tool that throws and provisions instead', () => {
    const boundary = boundaryWith({ 'app.mobileprovision': goodPlist() });
    boundary.exec.runSync = () => {
      throw new Error('security is not installed');
    };
    expect(cachedSigning(boundary, project, options)).toBeNull();
  });
});
