/**
 * App Store Connect: credentials, a signed JWT, and one request helper.
 *
 * `xcodebuild -allowProvisioningUpdates` rejects ASC API keys in headless
 * setups ("Authentication failed: bearer token") even though the same key works
 * against the REST API directly — so jetbridge registers bundle ids and creates
 * profiles itself, through this client.
 */
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { join } from 'node:path';
import type { Boundary } from './boundary.js';
import { envRefName, type Config } from './config.js';
import { fail } from './project.js';

export const ASC_BASE = 'https://api.appstoreconnect.apple.com';

/** Apple rejects a token older than 20 minutes. */
const TOKEN_TTL_SECONDS = 900;

export interface AscCredentials {
  keyPath: string;
  keyId: string;
  issuerId: string;
}

export function missingCredentialsMessage(config: Config): string {
  const ascKeyId = envRefName(config.credentials.ascKeyId);
  const ascIssuerId = envRefName(config.credentials.ascIssuerId);
  const ascKeyPath = envRefName(config.credentials.ascKeyPath);
  return (
    'App Store Connect credentials are not configured.\n' +
    `  Set ${ascKeyId} and ${ascIssuerId} in the environment, and place the private key at\n` +
    `  ~/.appstoreconnect/private_keys/AuthKey_<${ascKeyId}>.p8 (or point ${ascKeyPath} at it).`
  );
}

/** Apple's own search path for `AuthKey_<keyId>.p8`, in precedence order. */
export function keySearchDirs(boundary: Boundary): string[] {
  const home = boundary.homedir();
  return [
    join(boundary.cwd(), 'private_keys'),
    join(home, 'private_keys'),
    join(home, '.private_keys'),
    join(home, '.appstoreconnect', 'private_keys'),
  ];
}

/**
 * Resolve the key, or null when this machine has none. Null is not an error:
 * a plain build against an already-cached profile needs no credentials at all,
 * and saying so beats failing.
 */
export function localCredentials(boundary: Boundary, config: Config): AscCredentials | null {
  const keyId = boundary.env(envRefName(config.credentials.ascKeyId));
  const issuerId = boundary.env(envRefName(config.credentials.ascIssuerId));
  if (!keyId || !issuerId) return null;

  const explicit = boundary.env(envRefName(config.credentials.ascKeyPath));
  const keyPath =
    explicit ??
    keySearchDirs(boundary)
      .map((dir) => join(dir, `AuthKey_${keyId}.p8`))
      .find((path) => boundary.fs.exists(path));
  if (!keyPath || !boundary.fs.exists(keyPath)) return null;

  return { keyPath, keyId, issuerId };
}

const b64url = (value: Buffer): string => value.toString('base64url');

/**
 * A short-lived ES256 JWT. `dsaEncoding: 'ieee-p1363'` produces the raw r||s
 * signature JOSE requires — the DER encoding Node defaults to is rejected.
 */
export function mintToken(boundary: Boundary, credentials: AscCredentials): string {
  const now = boundary.now();
  const header = b64url(
    Buffer.from(JSON.stringify({ alg: 'ES256', kid: credentials.keyId, typ: 'JWT' })),
  );
  const payload = b64url(
    Buffer.from(
      JSON.stringify({
        iss: credentials.issuerId,
        iat: now,
        exp: now + TOKEN_TTL_SECONDS,
        aud: 'appstoreconnect-v1',
      }),
    ),
  );
  const input = `${header}.${payload}`;
  const key = createPrivateKey(boundary.fs.read(credentials.keyPath));
  const signature = cryptoSign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(signature)}`;
}

export interface AscResponse<T = unknown> {
  status: number;
  body: T;
}

export interface AscClient {
  request<T = AscDocument>(method: string, path: string, body?: unknown): Promise<AscResponse<T>>;
}

/** The subset of Apple's JSON:API envelope jetbridge reads. */
export interface AscResource {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
}

export interface AscDocument {
  data?: AscResource | AscResource[];
  /** Apple pages at 200 and puts the next page here, as an absolute URL. */
  links?: { next?: string };
  errors?: Array<{ code?: string; title?: string; detail?: string }>;
}

export function ascClient(boundary: Boundary, token: string): AscClient {
  return {
    async request(method, path, body) {
      const response = await boundary.http({
        method,
        url: `${ASC_BASE}${path}`,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: unknown = {};
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          // Apple answers some failures with HTML; keep the body for the message.
          parsed = { errors: [{ detail: text.slice(0, 400) }] };
        }
      }
      return { status: response.status, body: parsed } as AscResponse<never>;
    },
  };
}

/** Apple returns a list of problems; a single readable line is more use. */
export function describeAscError(body: unknown): string {
  const errors = (body as AscDocument)?.errors;
  if (!errors?.length) return typeof body === 'string' ? body : JSON.stringify(body);
  return errors.map((e) => [e.title, e.detail].filter(Boolean).join(': ')).join('; ');
}

export function requireCredentials(boundary: Boundary, config: Config): AscCredentials {
  const credentials = localCredentials(boundary, config);
  if (!credentials) fail(missingCredentialsMessage(config));
  return credentials;
}

/** The client every provisioning call runs through. */
export function connect(boundary: Boundary, config: Config): AscClient {
  return ascClient(boundary, mintToken(boundary, requireCredentials(boundary, config)));
}

export const asArray = (data: AscDocument['data']): AscResource[] =>
  Array.isArray(data) ? data : data ? [data] : [];
