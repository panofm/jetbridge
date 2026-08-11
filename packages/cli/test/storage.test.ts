/**
 * The bucket layer is the one part of an OTA install that fails silently on the
 * device: a wrong key layout, a missing credential or a bucket policy that
 * blocks reads all surface on the phone as "Cannot connect". Every one of those
 * is asserted here against a stubbed client, never against a bucket.
 */
import { describe, expect, it } from 'vitest';
import { parseConfig, type OtaConfig } from '../src/config.js';
import { JetbridgeError } from '../src/project.js';
import {
  createStore,
  objectKey,
  objectPrefix,
  projectToken,
  publicUrl,
  tokenPath,
  verifyReachable,
  type S3Factory,
} from '../src/storage.js';
import { testConfig } from './helpers/config.js';
import { fakeBoundary } from './helpers/fake-boundary.js';

const otaConfig = (
  overrides: { storage?: Record<string, unknown> } & Record<string, unknown> = {},
): OtaConfig => {
  const { storage, ...rest } = overrides;
  return testConfig({
    ota: {
      storage: {
        bucket: 'acme-builds',
        region: 'eu-central-1',
        publicBaseUrl: 'https://builds.example.com',
        ...storage,
      },
      ...rest,
    },
  }).ota!;
};

/** Records every command the store sends, and the client config it was made with. */
function stubS3(answers: Record<string, string> = {}): {
  factory: S3Factory;
  sent: Array<{ name: string; input: Record<string, unknown> }>;
  configs: unknown[];
} {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  const configs: unknown[] = [];
  const factory: S3Factory = (config) => {
    configs.push(config);
    return {
      async send(command) {
        const input = command.input as unknown as Record<string, unknown>;
        sent.push({ name: command.constructor.name, input });
        if (command.constructor.name === 'GetObjectCommand') {
          const body = answers[String(input.Key)];
          if (body === undefined)
            throw Object.assign(new Error('not found'), { name: 'NoSuchKey' });
          return { Body: { transformToString: async () => body } };
        }
        return {};
      },
    };
  };
  return { factory, sent, configs };
}

const withCredentials = (): ReturnType<typeof fakeBoundary> =>
  fakeBoundary({
    env: {
      JETBRIDGE_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      JETBRIDGE_S3_SECRET_ACCESS_KEY: 'secret-example',
    },
  });

describe('the config gate', () => {
  it('rejects an http publicBaseUrl, because iOS refuses to install over it', () => {
    const result = parseConfig({
      configVersion: 1,
      project: {
        xcodeproj: 'Acme.xcodeproj',
        scheme: 'Acme',
        teamId: 'ABCDE12345',
        baseBundleId: 'io.acme.app.dev',
      },
      variant: { displayName: 'Acme Dev' },
      ota: { storage: { bucket: 'acme-builds', publicBaseUrl: 'http://builds.example.com' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.message).join()).toContain('https://');
    }
  });
});

describe('object keys', () => {
  it('gates every key behind the token when access is "path"', () => {
    expect(objectKey(otaConfig(), 'ab12cd', 'builds', 'io.acme.app.dev-7', 'app.ipa')).toBe(
      'builds/ab12cd/builds/io.acme.app.dev-7/app.ipa',
    );
  });

  it('drops the token segment entirely when the bucket is private', () => {
    const ota = otaConfig({ access: 'none' });
    expect(objectPrefix(ota, 'ab12cd')).toBe('builds');
    expect(objectKey(ota, 'ab12cd', 'index.html')).toBe('builds/index.html');
  });

  it('tolerates a prefix written with slashes around it', () => {
    const ota = otaConfig({ storage: { prefix: '/ota/dist/' } });
    expect(objectKey(ota, 'ab12cd', 'index.html')).toBe('ota/dist/ab12cd/index.html');
  });

  it('joins the public URL without doubling the slash', () => {
    const ota = otaConfig({ storage: { publicBaseUrl: 'https://builds.example.com/' } });
    expect(publicUrl(ota, 'builds/ab12cd/index.html')).toBe(
      'https://builds.example.com/builds/ab12cd/index.html',
    );
  });
});

describe('the access token', () => {
  it('lives under the user cache directory, keyed by bundle id', () => {
    const boundary = fakeBoundary({ homedir: '/home/dev' });
    expect(tokenPath(boundary, 'io.acme.app.dev')).toBe(
      '/home/dev/Library/Caches/jetbridge/ota/io.acme.app.dev.token',
    );
  });

  it('mints once and returns the same token on every later run', () => {
    const boundary = fakeBoundary({ homedir: '/home/dev' });
    const first = projectToken(boundary, 'io.acme.app.dev');
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(projectToken(boundary, 'io.acme.app.dev')).toBe(first);
  });

  it('keeps two projects on one machine apart, so neither rewrites the other', () => {
    const boundary = fakeBoundary({ homedir: '/home/dev' });
    expect(projectToken(boundary, 'io.acme.app.dev')).not.toBe(
      projectToken(boundary, 'io.other.app.dev'),
    );
  });

  it('reuses a token already on disk', () => {
    const boundary = fakeBoundary({
      homedir: '/home/dev',
      files: { '/home/dev/Library/Caches/jetbridge/ota/io.acme.app.dev.token': 'deadbeef0011\n' },
    });
    expect(projectToken(boundary, 'io.acme.app.dev')).toBe('deadbeef0011');
  });
});

describe('the store', () => {
  it('reads credentials from the environment variables the config names', () => {
    const { factory, configs } = stubS3();
    createStore(withCredentials(), otaConfig(), factory);
    expect(configs[0]).toMatchObject({
      region: 'eu-central-1',
      credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-example' },
    });
  });

  it('names the missing variable when a credential is not set', () => {
    const { factory } = stubS3();
    expect(() => createStore(fakeBoundary(), otaConfig(), factory)).toThrow(JetbridgeError);
    expect(() => createStore(fakeBoundary(), otaConfig(), factory)).toThrow(
      /JETBRIDGE_S3_ACCESS_KEY_ID, JETBRIDGE_S3_SECRET_ACCESS_KEY/,
    );
  });

  it('forces path style for an S3-compatible endpoint', () => {
    const { factory, configs } = stubS3();
    createStore(
      withCredentials(),
      otaConfig({ storage: { endpoint: 'https://s3.example.com' } }),
      factory,
    );
    expect(configs[0]).toMatchObject({ endpoint: 'https://s3.example.com', forcePathStyle: true });
  });

  it('uploads with the bucket, key and content type it was given', async () => {
    const { factory, sent } = stubS3();
    const store = createStore(withCredentials(), otaConfig(), factory);
    await store.put(
      'builds/ab12cd/builds/x-1/app.ipa',
      new Uint8Array([1, 2]),
      'application/octet-stream',
    );
    expect(sent[0]).toMatchObject({
      name: 'PutObjectCommand',
      input: {
        Bucket: 'acme-builds',
        Key: 'builds/ab12cd/builds/x-1/app.ipa',
        ContentType: 'application/octet-stream',
        CacheControl: 'public, max-age=31536000, immutable',
      },
    });
  });

  it('never lets the index or the registry be cached — both are rewritten every publish', async () => {
    const { factory, sent } = stubS3();
    const store = createStore(withCredentials(), otaConfig(), factory);
    await store.put('builds/ab12cd/index.html', '<html></html>', 'text/html; charset=utf-8');
    await store.put('builds/ab12cd/builds.json', '[]', 'application/json');
    // The icon sits at the prefix root under a key that carries no build id, so
    // it is overwritten by every publish too.
    await store.put('builds/ab12cd/icon.png', new Uint8Array([1]), 'image/png');
    expect(sent.map((call) => call.input.CacheControl)).toEqual([
      'no-cache',
      'no-cache',
      'no-cache',
    ]);
  });

  it('reads an object back as text', async () => {
    const { factory } = stubS3({ 'builds/ab12cd/builds.json': '[{"buildId":"x"}]' });
    const store = createStore(withCredentials(), otaConfig(), factory);
    expect(await store.getText('builds/ab12cd/builds.json')).toBe('[{"buildId":"x"}]');
  });

  it('treats a missing object as the empty base case, not a failure', async () => {
    const { factory } = stubS3();
    const store = createStore(withCredentials(), otaConfig(), factory);
    expect(await store.getText('builds/ab12cd/builds.json')).toBeNull();
  });

  it('still throws when the bucket rejects the read for another reason', async () => {
    const factory: S3Factory = () => ({
      async send() {
        throw Object.assign(new Error('access denied'), { name: 'AccessDenied' });
      },
    });
    const store = createStore(withCredentials(), otaConfig(), factory);
    await expect(store.getText('builds/ab12cd/builds.json')).rejects.toThrow('access denied');
  });
});

describe('the reachability preflight', () => {
  const manifestUrl = 'https://builds.example.com/builds/ab12cd/builds/x-1/manifest.plist';

  it('passes when the manifest answers 200', async () => {
    const boundary = fakeBoundary({
      requests: [{ method: 'HEAD', url: manifestUrl, status: 200 }],
    });
    await expect(verifyReachable(boundary, otaConfig(), manifestUrl)).resolves.toBeUndefined();
    expect(boundary.requests[0]).toMatchObject({ method: 'HEAD', url: manifestUrl });
  });

  it('blames the bucket policy on a 403 and says what to grant', async () => {
    const boundary = fakeBoundary({
      requests: [{ method: 'HEAD', url: manifestUrl, status: 403 }],
    });
    await expect(verifyReachable(boundary, otaConfig(), manifestUrl)).rejects.toThrow(
      /bucket policy on "acme-builds"/,
    );
    await expect(verifyReachable(boundary, otaConfig(), manifestUrl)).rejects.toThrow(
      /s3:GetObject on "builds\/\*".*never s3:ListBucket/s,
    );
  });

  it('points at the base URL or prefix on a 404', async () => {
    const boundary = fakeBoundary({
      requests: [{ method: 'HEAD', url: manifestUrl, status: 404 }],
    });
    await expect(verifyReachable(boundary, otaConfig(), manifestUrl)).rejects.toThrow(
      /publicBaseUrl or prefix does not match/,
    );
  });
});
