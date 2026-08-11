/**
 * The provisioner was a Python script talking to App Store Connect. A wrong
 * port registers real bundle ids and profiles on a real developer account, so
 * it is verified by asserting the request shapes — method, path and body —
 * against a fake, never against Apple.
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AscClient, AscResponse } from '../src/asc.js';
import { JetbridgeError, projectFrom } from '../src/project.js';
import {
  certificateTypeFor,
  ensureBundleId,
  ensureCapabilities,
  enabledDeviceIds,
  localCertificateId,
  profileDirectory,
  profileNameFor,
  profileUuid,
  provisionVariant,
  targetBundleId,
  targetEntityName,
} from '../src/provision.js';
import { fakeBoundary, type FakeBoundary } from './helpers/fake-boundary.js';
import type { ResolvedTarget } from '../src/bundle-ids.js';
import { testConfig } from './helpers/config.js';
import { PROJECT_FILES } from './helpers/pbxproj.js';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
}

/** A client that records calls and replays canned answers in order per path. */
function recordingClient(answers: Array<{ match: string; status: number; body?: unknown }>): {
  client: AscClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const used = new Set<number>();
  const client: AscClient = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      const index = answers.findIndex(
        (a, i) => !used.has(i) && path.includes(a.match) && a.match.length > 0,
      );
      if (index === -1) return { status: 404, body: {} } as AscResponse<never>;
      used.add(index);
      return {
        status: answers[index]!.status,
        body: answers[index]!.body ?? {},
      } as AscResponse<never>;
    },
  };
  return { client, calls };
}

/** A minimal signed profile: jetbridge only reads the UUID out of the plist. */
const profilePayload = (uuid: string): string =>
  Buffer.from(
    `\x30\x82BINARYCMSHEADER<?xml version="1.0"?><plist version="1.0"><dict>` +
      `<key>Name</key><string>Acme wave app</string>` +
      `<key>UUID</key><string>${uuid}</string>` +
      `</dict></plist>TRAILINGSIGNATUREBYTES`,
    'binary',
  ).toString('base64');

const config = testConfig({
  variant: {
    displayName: 'Acme Dev',
    targets: [
      { name: 'Acme', variantEntitlements: 'ios/Acme.variant.entitlements' },
      { name: 'Upload Widget', bundleIdSuffix: 'uploadwidget' },
    ],
  },
});

const project = projectFrom('/w/jetbridge.config.json', config);

/** The extension, as the project file resolves it. */
const extension: ResolvedTarget = { name: 'Upload Widget', bundleIdSuffix: 'uploadwidget' };

const boundaryWithCredentials = (
  overrides: Parameters<typeof fakeBoundary>[0] = {},
): FakeBoundary =>
  fakeBoundary({
    homedir: '/home/dev',
    env: { ASC_API_KEY_ID: 'KEY1', ASC_API_ISSUER_ID: 'ISSUER1' },
    files: {
      ...PROJECT_FILES,
      '/home/dev/.appstoreconnect/private_keys/AuthKey_KEY1.p8': KEY_PEM,
    },
    commands: [
      {
        match: ['security', 'find-identity'],
        stdout: '1) ABC "Apple Development: Dev Eloper (SKAV8355Y7)"',
      },
    ],
    ...overrides,
  });

describe('bundle ids', () => {
  it('builds the app id from the base and the slug', () => {
    expect(targetBundleId(config.variant.targets[0]!, 'wave', config)).toBe('io.acme.app.dev.wave');
  });

  it('nests an extension under the app id', () => {
    expect(targetBundleId(extension, 'wave', config)).toBe('io.acme.app.dev.wave.uploadwidget');
  });

  it('names the app entity after the home-screen label', () => {
    expect(targetEntityName(config.variant.targets[0]!, 'Acme Wave')).toBe('Acme Wave');
  });

  it('names an extension after the app plus the target', () => {
    expect(targetEntityName(extension, 'Acme Wave')).toBe('Acme Wave Upload Widget');
  });

  it('sanitises the entity name, because App Store Connect rejects punctuation', () => {
    expect(targetEntityName(config.variant.targets[0]!, 'Acme_Hello_World')).toBe(
      'Acme Hello World',
    );
  });
});

describe('ensureBundleId', () => {
  it('reuses an exactly-matching registration', async () => {
    const { client, calls } = recordingClient([
      {
        match: '/v1/bundleIds?filter',
        status: 200,
        body: {
          data: [{ id: 'ROW1', type: 'bundleIds', attributes: { identifier: 'io.acme.a' } }],
        },
      },
    ]);
    expect(await ensureBundleId(client, 'io.acme.a', 'Acme')).toBe('ROW1');
    expect(calls).toHaveLength(1);
  });

  it('ignores a prefix match, because Apple filters by prefix', async () => {
    // `io.acme.a` must not be satisfied by an existing `io.acme.ab`.
    const { client, calls } = recordingClient([
      {
        match: '/v1/bundleIds?filter',
        status: 200,
        body: {
          data: [{ id: 'OTHER', type: 'bundleIds', attributes: { identifier: 'io.acme.ab' } }],
        },
      },
      { match: '/v1/bundleIds', status: 201, body: { data: { id: 'NEW', type: 'bundleIds' } } },
    ]);
    expect(await ensureBundleId(client, 'io.acme.a', 'Acme')).toBe('NEW');
    expect(calls[1]!.method).toBe('POST');
  });

  it('registers with the platform Apple requires', async () => {
    const { client, calls } = recordingClient([
      { match: '/v1/bundleIds?filter', status: 200, body: { data: [] } },
      { match: '/v1/bundleIds', status: 201, body: { data: { id: 'NEW', type: 'bundleIds' } } },
    ]);
    await ensureBundleId(client, 'io.acme.a', 'Acme Wave');
    expect(calls[1]!.body).toEqual({
      data: {
        type: 'bundleIds',
        attributes: { identifier: 'io.acme.a', name: 'Acme Wave', platform: 'IOS' },
      },
    });
  });

  it('escapes the identifier in the query', async () => {
    const { client, calls } = recordingClient([
      { match: '/v1/bundleIds?filter', status: 200, body: { data: [] } },
      { match: '/v1/bundleIds', status: 201, body: { data: { id: 'NEW', type: 'bundleIds' } } },
    ]);
    await ensureBundleId(client, 'io.acme a', 'Acme');
    expect(calls[0]!.path).toContain('io.acme%20a');
  });

  it('explains a rejected registration', async () => {
    const { client } = recordingClient([
      { match: '/v1/bundleIds?filter', status: 200, body: { data: [] } },
      {
        match: '/v1/bundleIds',
        status: 409,
        body: { errors: [{ title: 'Entity error', detail: 'already exists' }] },
      },
    ]);
    await expect(ensureBundleId(client, 'io.acme.a', 'Acme')).rejects.toThrow(
      /could not register the bundle id io\.acme\.a: 409 Entity error: already exists/,
    );
  });
});

describe('ensureCapabilities', () => {
  it('posts one request per capability, related to the bundle id', async () => {
    const { client, calls } = recordingClient([
      { match: '/v1/bundleIdCapabilities', status: 201 },
      { match: '/v1/bundleIdCapabilities', status: 201 },
    ]);
    await ensureCapabilities(client, 'ROW1', ['PUSH_NOTIFICATIONS', 'ASSOCIATED_DOMAINS']);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toEqual({
      data: {
        type: 'bundleIdCapabilities',
        attributes: { capabilityType: 'PUSH_NOTIFICATIONS' },
        relationships: { bundleId: { data: { type: 'bundleIds', id: 'ROW1' } } },
      },
    });
  });

  it('treats 409 as already enabled', async () => {
    const { client } = recordingClient([{ match: '/v1/bundleIdCapabilities', status: 409 }]);
    await expect(
      ensureCapabilities(client, 'ROW1', ['PUSH_NOTIFICATIONS']),
    ).resolves.toBeUndefined();
  });

  it('fails on any other rejection', async () => {
    const { client } = recordingClient([
      { match: '/v1/bundleIdCapabilities', status: 422, body: { errors: [{ title: 'bad' }] } },
    ]);
    await expect(ensureCapabilities(client, 'ROW1', ['NOPE'])).rejects.toThrow(
      /could not enable NOPE: 422 bad/,
    );
  });

  it('does nothing when there are no capabilities to enable', async () => {
    const { client, calls } = recordingClient([]);
    await ensureCapabilities(client, 'ROW1', []);
    expect(calls).toHaveLength(0);
  });
});

describe('certificateTypeFor', () => {
  /**
   * Apple enforces this pairing and rejects a mismatch with a 409 that reads
   * like a MISSING certificate rather than the wrong kind of one. Asking for an
   * ad hoc profile while looking up a development certificate is exactly how
   * that failure reaches a user.
   */
  it('pairs a development profile with a development certificate', () => {
    expect(certificateTypeFor('IOS_APP_DEVELOPMENT')).toBe('DEVELOPMENT');
  });

  it('pairs ad hoc and in-house profiles with a distribution certificate', () => {
    expect(certificateTypeFor('IOS_APP_ADHOC')).toBe('DISTRIBUTION');
    expect(certificateTypeFor('IOS_APP_INHOUSE')).toBe('DISTRIBUTION');
    expect(certificateTypeFor('IOS_APP_STORE')).toBe('DISTRIBUTION');
  });
});

describe('localCertificateId', () => {
  it('asks Apple for the certificate kind it was given', async () => {
    const boundary = boundaryWithCredentials();
    const { client, calls } = recordingClient([
      {
        match: '/v1/certificates',
        status: 200,
        body: {
          data: [
            {
              id: 'DIST',
              type: 'certificates',
              attributes: { displayName: 'Apple Development: Dev Eloper (SKAV8355Y7)' },
            },
          ],
        },
      },
    ]);
    await localCertificateId(boundary, client, 'DISTRIBUTION');
    expect(calls[0]!.path).toContain('filter[certificateType]=DISTRIBUTION');
  });

  it('says how to avoid needing a distribution certificate at all', async () => {
    const boundary = boundaryWithCredentials();
    const { client } = recordingClient([
      { match: '/v1/certificates', status: 200, body: { data: [] } },
    ]);
    await expect(localCertificateId(boundary, client, 'DISTRIBUTION')).rejects.toThrow(
      /ota\.exportMethod/,
    );
  });

  it('picks the certificate whose private key is in this keychain', async () => {
    const boundary = boundaryWithCredentials();
    const { client } = recordingClient([
      {
        match: '/v1/certificates',
        status: 200,
        body: {
          data: [
            { id: 'OTHER', type: 'certificates', attributes: { displayName: 'Someone Else' } },
            {
              id: 'MINE',
              type: 'certificates',
              attributes: { displayName: 'Apple Development: Dev Eloper (SKAV8355Y7)' },
            },
          ],
        },
      },
    ]);
    expect(await localCertificateId(boundary, client)).toBe('MINE');
  });

  it('asks the keychain for codesigning identities', async () => {
    const boundary = boundaryWithCredentials();
    const { client } = recordingClient([
      {
        match: '/v1/certificates',
        status: 200,
        body: {
          data: [
            {
              id: 'MINE',
              type: 'certificates',
              attributes: { displayName: 'Apple Development: Dev Eloper (SKAV8355Y7)' },
            },
          ],
        },
      },
    ]);
    await localCertificateId(boundary, client);
    expect(boundary.commandLines()).toContain('security find-identity -v -p codesigning');
  });

  it('filters to development certificates', async () => {
    const boundary = boundaryWithCredentials();
    const { client, calls } = recordingClient([
      {
        match: '/v1/certificates',
        status: 200,
        body: {
          data: [
            {
              id: 'MINE',
              type: 'certificates',
              attributes: { displayName: 'Apple Development: Dev Eloper (SKAV8355Y7)' },
            },
          ],
        },
      },
    ]);
    await localCertificateId(boundary, client);
    expect(calls[0]!.path).toContain('filter[certificateType]=DEVELOPMENT');
  });

  it('says what to do when no certificate matches', async () => {
    const boundary = boundaryWithCredentials();
    const { client } = recordingClient([
      {
        match: '/v1/certificates',
        status: 200,
        body: {
          data: [
            { id: 'OTHER', type: 'certificates', attributes: { displayName: 'Someone Else' } },
          ],
        },
      },
    ]);
    await expect(localCertificateId(boundary, client)).rejects.toThrow(
      /matches a signing identity in this keychain/,
    );
  });
});

describe('enabledDeviceIds', () => {
  it('asks only for enabled iOS devices', async () => {
    const { client, calls } = recordingClient([
      { match: '/v1/devices', status: 200, body: { data: [{ id: 'D1' }, { id: 'D2' }] } },
    ]);
    expect(await enabledDeviceIds(client)).toEqual(['D1', 'D2']);
    expect(calls[0]!.path).toContain('filter[platform]=IOS');
    expect(calls[0]!.path).toContain('filter[status]=ENABLED');
  });

  it('explains a failed listing', async () => {
    const { client } = recordingClient([
      { match: '/v1/devices', status: 401, body: { errors: [{ title: 'NOT_AUTHORIZED' }] } },
    ]);
    await expect(enabledDeviceIds(client)).rejects.toThrow(/could not list registered devices/);
  });
});

describe('profileUuid', () => {
  it('reads the UUID out of the plist inside the CMS envelope', () => {
    const bytes = Buffer.from(profilePayload('ABC-123'), 'base64');
    expect(profileUuid(new Uint8Array(bytes))).toBe('ABC-123');
  });

  it('fails clearly when there is no plist', () => {
    expect(() => profileUuid(new TextEncoder().encode('not a profile'))).toThrow(/no plist inside/);
  });

  it('fails clearly when the plist carries no UUID', () => {
    const bytes = new TextEncoder().encode('<?xml?><plist><dict></dict></plist>');
    expect(() => profileUuid(bytes)).toThrow(/carries no UUID/);
  });
});

describe('profileNameFor', () => {
  it('names the app profile after the label prefix and the slug', () => {
    expect(profileNameFor(config.variant.targets[0]!, 'wave', config)).toBe('Acme wave app');
  });

  it('names an extension profile after its bundle-id segment', () => {
    expect(profileNameFor(extension, 'wave', config)).toBe('Acme wave uploadwidget');
  });

  it('takes its prefix from the display name, with nothing to configure', () => {
    const renamed = testConfig({
      variant: { displayName: 'Widgets Dev', targets: [{ name: 'App' }] },
    });
    expect(profileNameFor(renamed.variant.targets[0]!, 'wave', renamed)).toBe('Widgets wave app');
  });
});

describe('provisionVariant', () => {
  const answersForFullRun = () => [
    { match: '/v1/bundleIds?filter', status: 200, body: { data: [] } },
    { match: '/v1/bundleIds', status: 201, body: { data: { id: 'APP_ROW', type: 'bundleIds' } } },
    { match: '/v1/bundleIdCapabilities', status: 201 },
    { match: '/v1/bundleIds?filter', status: 200, body: { data: [] } },
    {
      match: '/v1/bundleIds',
      status: 201,
      body: { data: { id: 'WIDGET_ROW', type: 'bundleIds' } },
    },
    {
      match: '/v1/certificates',
      status: 200,
      body: {
        data: [
          {
            id: 'CERT1',
            type: 'certificates',
            attributes: { displayName: 'Apple Development: Dev Eloper (SKAV8355Y7)' },
          },
        ],
      },
    },
    { match: '/v1/devices', status: 200, body: { data: [{ id: 'D1' }] } },
    { match: '/v1/profiles?filter', status: 200, body: { data: [] } },
    {
      match: '/v1/profiles',
      status: 201,
      body: {
        data: {
          id: 'P1',
          type: 'profiles',
          attributes: { profileContent: profilePayload('UUID-APP') },
        },
      },
    },
    { match: '/v1/profiles?filter', status: 200, body: { data: [] } },
    {
      match: '/v1/profiles',
      status: 201,
      body: {
        data: {
          id: 'P2',
          type: 'profiles',
          attributes: { profileContent: profilePayload('UUID-WIDGET') },
        },
      },
    },
  ];

  it('rejects a config with no targets', async () => {
    const bare = projectFrom('/w/jetbridge.config.json', testConfig());
    await expect(
      provisionVariant(boundaryWithCredentials(), bare, {
        suffix: 'wave',
        displayName: 'Acme Wave',
      }),
    ).rejects.toThrow(/at least one entry in variant\.targets/);
  });

  it('requires credentials before touching the network', async () => {
    const boundary = fakeBoundary({ homedir: '/home/dev' });
    await expect(
      provisionVariant(boundary, project, { suffix: 'wave', displayName: 'Acme Wave' }),
    ).rejects.toThrow(JetbridgeError);
    expect(boundary.requests).toHaveLength(0);
  });

  /**
   * The capability list is derived from the target's entitlements, so this is
   * what actually reaches Apple. A hand-written list could disagree with the
   * file the build signs against; this pins that it cannot.
   */
  it('enables exactly the capabilities the variant entitlements declare', async () => {
    const answers = answersForFullRun();
    const boundary = boundaryWithCredentials({
      files: {
        ...PROJECT_FILES,
        '/home/dev/.appstoreconnect/private_keys/AuthKey_KEY1.p8': KEY_PEM,
        '/w/ios/Acme.variant.entitlements': `<plist version="1.0"><dict>
	<key>aps-environment</key><string>development</string>
	<key>com.apple.developer.associated-domains</key>
	<array><string>applinks:acme.example</string></array>
	<key>com.apple.developer.team-identifier</key><string>ABCDE12345</string>
</dict></plist>`,
      },
      requests: answers.map((a) => ({ url: a.match, status: a.status, body: a.body })),
    });

    await provisionVariant(boundary, project, { suffix: 'wave', displayName: 'Acme Wave' });

    const enabled = boundary.requests
      .filter((request) => request.url.includes('/v1/bundleIdCapabilities'))
      .map(
        (request) =>
          (JSON.parse(request.body!) as { data: { attributes: { capabilityType: string } } }).data
            .attributes.capabilityType,
      );
    // The extension declares no entitlements file, so it asks for nothing —
    // and `team-identifier` is not a capability, so it is skipped.
    expect(enabled).toEqual(['PUSH_NOTIFICATIONS', 'ASSOCIATED_DOMAINS']);
  });

  it('refuses when the team has no enabled devices', async () => {
    const answers = answersForFullRun().map((a) =>
      a.match === '/v1/devices' ? { ...a, body: { data: [] } } : a,
    );
    const boundary = boundaryWithCredentials({
      requests: answers.map((a) => ({ url: a.match, status: a.status, body: a.body })),
    });
    await expect(
      provisionVariant(boundary, project, { suffix: 'wave', displayName: 'Acme Wave' }),
    ).rejects.toThrow(/no enabled iOS devices/);
  });
});

describe('profileDirectory', () => {
  it('is where Xcode reads installed profiles from', () => {
    expect(profileDirectory(fakeBoundary({ homedir: '/home/dev' }))).toBe(
      '/home/dev/Library/MobileDevice/Provisioning Profiles',
    );
  });
});
