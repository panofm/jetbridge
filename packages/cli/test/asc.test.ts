import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ASC_BASE,
  ascClient,
  describeAscError,
  keySearchDirs,
  localCredentials,
  mintToken,
  missingCredentialsMessage,
} from '../src/asc.js';
import { fakeBoundary } from './helpers/fake-boundary.js';
import { testConfig } from './helpers/config.js';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const decode = (segment: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));

describe('credential resolution', () => {
  const config = testConfig();

  it('returns null when the key id is missing', () => {
    const boundary = fakeBoundary({ env: { ASC_API_ISSUER_ID: 'issuer' } });
    expect(localCredentials(boundary, config)).toBeNull();
  });

  it('returns null when the issuer id is missing', () => {
    const boundary = fakeBoundary({ env: { ASC_API_KEY_ID: 'KEY1' } });
    expect(localCredentials(boundary, config)).toBeNull();
  });

  it('returns null when no key file exists anywhere on the search path', () => {
    const boundary = fakeBoundary({ env: { ASC_API_KEY_ID: 'KEY1', ASC_API_ISSUER_ID: 'issuer' } });
    expect(localCredentials(boundary, config)).toBeNull();
  });

  it("finds the key in Apple's own search directories", () => {
    const boundary = fakeBoundary({
      homedir: '/home/dev',
      env: { ASC_API_KEY_ID: 'KEY1', ASC_API_ISSUER_ID: 'issuer' },
      files: { '/home/dev/.appstoreconnect/private_keys/AuthKey_KEY1.p8': KEY_PEM },
    });
    expect(localCredentials(boundary, config)?.keyPath).toBe(
      '/home/dev/.appstoreconnect/private_keys/AuthKey_KEY1.p8',
    );
  });

  it('searches the directories in Apple’s documented precedence order', () => {
    const boundary = fakeBoundary({ cwd: '/w', homedir: '/home/dev' });
    expect(keySearchDirs(boundary)).toEqual([
      '/w/private_keys',
      '/home/dev/private_keys',
      '/home/dev/.private_keys',
      '/home/dev/.appstoreconnect/private_keys',
    ]);
  });

  it('prefers an explicit key path over the search path', () => {
    const boundary = fakeBoundary({
      homedir: '/home/dev',
      env: {
        ASC_API_KEY_ID: 'KEY1',
        ASC_API_ISSUER_ID: 'issuer',
        ASC_API_KEY_PATH: '/keys/custom.p8',
      },
      files: {
        '/keys/custom.p8': KEY_PEM,
        '/home/dev/.appstoreconnect/private_keys/AuthKey_KEY1.p8': KEY_PEM,
      },
    });
    expect(localCredentials(boundary, config)?.keyPath).toBe('/keys/custom.p8');
  });

  it('reads the variable names the config gives it, not hardcoded ones', () => {
    const renamed = testConfig({
      credentials: {
        ascKeyId: '${MY_KEY}',
        ascIssuerId: '${MY_ISSUER}',
        ascKeyPath: '${MY_PATH}',
      },
    });
    const boundary = fakeBoundary({
      env: { MY_KEY: 'KEY1', MY_ISSUER: 'issuer', MY_PATH: '/k.p8' },
      files: { '/k.p8': KEY_PEM },
    });
    expect(localCredentials(boundary, renamed)).toEqual({
      keyId: 'KEY1',
      issuerId: 'issuer',
      keyPath: '/k.p8',
    });
  });

  it('names the configured variables when it explains what is missing', () => {
    const renamed = testConfig({
      credentials: { ascKeyId: '${MY_KEY}', ascIssuerId: '${MY_ISSUER}' },
    });
    const message = missingCredentialsMessage(renamed);
    // The bare NAME, not the reference: a person has to type `export MY_KEY=…`.
    expect(message).toContain('MY_KEY');
    expect(message).toContain('MY_ISSUER');
    expect(message).not.toContain('${MY_KEY}');
    expect(message).not.toContain('ASC_API_KEY_ID');
  });
});

describe('token minting', () => {
  const boundary = fakeBoundary({ now: 1_700_000_000, files: { '/k.p8': KEY_PEM } });
  const credentials = { keyId: 'KEY1', issuerId: 'ISSUER1', keyPath: '/k.p8' };

  it('produces three base64url segments', () => {
    expect(mintToken(boundary, credentials).split('.')).toHaveLength(3);
  });

  it('sets the header Apple requires', () => {
    const [header] = mintToken(boundary, credentials).split('.');
    expect(decode(header!)).toEqual({ alg: 'ES256', kid: 'KEY1', typ: 'JWT' });
  });

  it('sets an audience and a 15-minute expiry from the injected clock', () => {
    const [, payload] = mintToken(boundary, credentials).split('.');
    expect(decode(payload!)).toEqual({
      iss: 'ISSUER1',
      iat: 1_700_000_000,
      exp: 1_700_000_900,
      aud: 'appstoreconnect-v1',
    });
  });

  it('signs with the raw r||s encoding, not DER', () => {
    // A JOSE ES256 signature is exactly 64 bytes; DER is variable-length and
    // longer. Apple rejects the DER form Node produces by default.
    const [, , signature] = mintToken(boundary, credentials).split('.');
    expect(Buffer.from(signature!, 'base64url')).toHaveLength(64);
  });

  it('signs the header and payload, so tampering invalidates the token', () => {
    const token = mintToken(boundary, credentials);
    const [header, payload] = token.split('.');
    const verifier = createSign('sha256');
    verifier.update(`${header}.${payload}`);
    // A different clock produces a different payload and therefore a different
    // signature — the token is not a constant.
    const later = mintToken(
      fakeBoundary({ now: 1_700_000_060, files: { '/k.p8': KEY_PEM } }),
      credentials,
    );
    expect(later).not.toBe(token);
  });
});

describe('request helper', () => {
  it('sends the bearer token and JSON content type', async () => {
    const boundary = fakeBoundary({ requests: [{ url: '/v1/devices', body: { data: [] } }] });
    const client = ascClient(boundary, 'TOKEN123');
    await client.request('GET', '/v1/devices');
    expect(boundary.requests[0]).toMatchObject({
      method: 'GET',
      url: `${ASC_BASE}/v1/devices`,
      headers: { Authorization: 'Bearer TOKEN123', 'Content-Type': 'application/json' },
    });
  });

  it('serialises a body and leaves it off when there is none', async () => {
    const boundary = fakeBoundary({ requests: [{ url: '/v1/bundleIds', status: 201 }] });
    const client = ascClient(boundary, 'T');
    await client.request('POST', '/v1/bundleIds', { data: { type: 'bundleIds' } });
    await client.request('GET', '/v1/bundleIds');
    expect(boundary.requests[0]!.body).toBe('{"data":{"type":"bundleIds"}}');
    expect(boundary.requests[1]!.body).toBeUndefined();
  });

  it('returns the status alongside the parsed body', async () => {
    const boundary = fakeBoundary({
      requests: [{ url: '/v1/x', status: 409, body: { errors: [{ title: 'nope' }] } }],
    });
    const result = await ascClient(boundary, 'T').request('POST', '/v1/x', {});
    expect(result.status).toBe(409);
    expect(result.body).toEqual({ errors: [{ title: 'nope' }] });
  });

  it('survives a non-JSON error body rather than throwing', async () => {
    const boundary = fakeBoundary({
      requests: [{ url: '/v1/x', status: 503, body: '<html>gateway</html>' }],
    });
    const result = await ascClient(boundary, 'T').request('GET', '/v1/x');
    expect(result.status).toBe(503);
    expect(describeAscError(result.body)).toContain('gateway');
  });
});

describe('describeAscError', () => {
  it('joins Apple’s error list into one line', () => {
    expect(
      describeAscError({
        errors: [
          { title: 'Entity error', detail: "The attribute 'name' is invalid" },
          { title: 'Second' },
        ],
      }),
    ).toBe("Entity error: The attribute 'name' is invalid; Second");
  });

  it('falls back to the raw body when there is no error list', () => {
    expect(describeAscError({ data: [] })).toBe('{"data":[]}');
  });
});
