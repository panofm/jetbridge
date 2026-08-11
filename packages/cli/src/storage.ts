/**
 * The bucket half of an over-the-air install: where an object lands, what URL
 * the phone fetches it from, and the check that it can.
 *
 * Nothing here knows what a build is. It knows keys, bytes and one HEAD
 * request — which is what lets the whole upload path be tested without a
 * network, and what keeps the reachability check in one place instead of at
 * every call site that prints a URL.
 */
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Boundary } from './boundary.js';
import type { OtaConfig } from './config.js';
import { fail } from './project.js';

/** The slice of the S3 client this tool uses. A test supplies its own. */
export interface S3Like {
  send(command: PutObjectCommand | GetObjectCommand): Promise<{
    Body?: { transformToString(): Promise<string> };
  }>;
}

export type S3Factory = (config: S3ClientConfig) => S3Like;

// The real client's `send` is a union of every command overload; narrowing it to
// the two commands used here is the whole point of `S3Like`.
export const awsS3Factory: S3Factory = (config) => new S3Client(config) as unknown as S3Like;

export interface ObjectStore {
  put(key: string, body: string | Uint8Array, contentType: string): Promise<void>;
  /** The object's text, or null when it is not there yet. */
  getText(key: string): Promise<string | null>;
}

/**
 * Credentials come from the environment, named by the config. A bucket secret
 * in a file that lives in the repository is the one mistake this tool must not
 * make easy, so the config carries variable NAMES and never values.
 */
export function credentials(
  boundary: Boundary,
  ota: OtaConfig,
): { accessKeyId: string; secretAccessKey: string } {
  const accessKeyId = boundary.env(ota.storage.accessKeyId)?.trim();
  const secretAccessKey = boundary.env(ota.storage.secretAccessKey)?.trim();
  if (!accessKeyId || !secretAccessKey) {
    const missing = [
      !accessKeyId ? ota.storage.accessKeyId : null,
      !secretAccessKey ? ota.storage.secretAccessKey : null,
    ].filter(Boolean);
    fail(
      `the OTA bucket credentials are not set: ${missing.join(', ')}.\n` +
        '  Export them in this shell, or point ota.storage.accessKeyId / secretAccessKey at the\n' +
        '  variable names you already use.',
    );
  }
  return { accessKeyId, secretAccessKey };
}

/**
 * Which objects may be cached forever.
 *
 * A build's .ipa and manifest are immutable — their key carries the build id.
 * Everything else is rewritten on every publish, including the icon, which
 * lives at the prefix root: cache that for a year and a changed app icon never
 * reaches the install tile again.
 */
const MUTABLE = ['.html', '.json', '.png'];

const cacheControlFor = (key: string): string =>
  MUTABLE.some((suffix) => key.endsWith(suffix))
    ? 'no-cache'
    : 'public, max-age=31536000, immutable';

export function createStore(
  boundary: Boundary,
  ota: OtaConfig,
  factory: S3Factory = awsS3Factory,
): ObjectStore {
  const { bucket, region, endpoint } = ota.storage;
  const client = factory({
    region,
    // An S3-compatible host (R2, MinIO, Backblaze) rarely serves virtual-hosted
    // style, and getting it wrong reads as a DNS failure rather than a config one.
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    credentials: credentials(boundary, ota),
  });

  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          // No `ACL: public-read`: readability comes from the bucket policy on
          // the prefix, which is the only thing that works on a bucket with
          // Block Public ACLs on — which is the default on a new bucket.
          CacheControl: cacheControlFor(key),
        }),
      );
    },
    async getText(key) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return (await result.Body?.transformToString()) ?? null;
      } catch (error) {
        // A first-ever publish has no registry yet. That is the empty base
        // case, not a failure.
        const code =
          (error as { name?: string; Code?: string }).name ?? (error as { Code?: string }).Code;
        if (code === 'NoSuchKey' || code === 'NotFound') return null;
        throw error;
      }
    },
  };
}

/**
 * The path segment that gates the install URL.
 *
 * `access: 'path'` puts an unguessable segment in every key, so a visitor at
 * the bucket root has nothing to browse. iOS fetches the manifest and the .ipa
 * with no auth header, so a URL-as-secret is the pattern that fits: a presigned
 * URL expires inside a page that is meant to stay bookmarkable for weeks.
 */
export function objectPrefix(ota: OtaConfig, token: string): string {
  const segments = [
    ota.storage.prefix.replace(/^\/+|\/+$/g, ''),
    ota.access === 'path' ? token : '',
  ];
  return segments.filter(Boolean).join('/');
}

export function objectKey(ota: OtaConfig, token: string, ...segments: string[]): string {
  return [objectPrefix(ota, token), ...segments].filter(Boolean).join('/');
}

export function publicUrl(ota: OtaConfig, key: string): string {
  return `${ota.storage.publicBaseUrl.replace(/\/+$/, '')}/${key}`;
}

/**
 * Where a project's access token is kept.
 *
 * Keyed by the base bundle id, under the user cache directory — NOT one dotfile
 * in $HOME. Two checkouts on one machine publish two different apps, and a
 * shared file means the second one silently rewrites the first one's install
 * URL. Every variant of one project shares the token deliberately: they publish
 * to one prefix and one index page.
 */
export function tokenPath(boundary: Boundary, bundleId: string): string {
  return join(boundary.homedir(), 'Library', 'Caches', 'jetbridge', 'ota', `${bundleId}.token`);
}

/** ~48 bits — long enough that guessing it is not a strategy. */
export function projectToken(boundary: Boundary, bundleId: string): string {
  const path = tokenPath(boundary, bundleId);
  if (boundary.fs.exists(path)) {
    const existing = boundary.fs.read(path).trim();
    if (existing) return existing;
  }
  const token = randomBytes(6).toString('hex');
  boundary.fs.write(path, `${token}\n`);
  return token;
}

/**
 * The single most useful check in the whole flow: can the device actually GET
 * the manifest?
 *
 * A bucket that uploads fine but serves 403 is the common misconfiguration, and
 * iOS reports it as "Cannot connect to <host>" with nothing else — no status,
 * no URL, no hint that the bytes are there and the policy is wrong. So the
 * manifest is fetched over HTTPS here, before any URL is printed.
 */
export async function verifyReachable(
  boundary: Boundary,
  ota: OtaConfig,
  manifestUrl: string,
): Promise<void> {
  let status: number;
  try {
    const response = await boundary.http({ method: 'HEAD', url: manifestUrl, headers: {} });
    status = response.status;
  } catch (error) {
    fail(
      `could not reach the uploaded manifest at ${manifestUrl} — ${(error as Error).message}.\n` +
        `  Check that ota.storage.publicBaseUrl points at how bucket "${ota.storage.bucket}" is served.`,
    );
  }
  if (status >= 200 && status < 300) return;

  const cause =
    status === 403 || status === 401
      ? `the bucket policy on "${ota.storage.bucket}" does not allow public reads of this prefix`
      : status === 404
        ? 'the object is not at that URL, so ota.storage.publicBaseUrl or prefix does not match the bucket'
        : 'the bucket returned an unexpected status';
  fail(
    `the manifest is not reachable: HTTP ${status} on ${manifestUrl}.\n` +
      `  Likely cause: ${cause}.\n` +
      `  Grant s3:GetObject on "${ota.storage.prefix}/*" to everyone (never s3:ListBucket), then\n` +
      '  re-run. iOS reports this failure only as "Cannot connect", so it is checked here instead.',
  );
}
