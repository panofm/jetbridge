/**
 * Registering a variant's signing, headlessly.
 *
 * For each target that needs its own bundle id: make sure the id exists, make
 * sure its capabilities are on, then create a fresh provisioning profile over
 * the local development certificate and every enabled device, and install it
 * where Xcode looks for it.
 *
 * Idempotent by design. An existing bundle id is success; an existing profile
 * of the same name is deleted and recreated, because its device list and
 * certificate go stale the moment a new phone is registered.
 */
import { join } from 'node:path';
import {
  asArray,
  connect,
  describeAscError,
  type AscClient,
  type AscDocument,
  type AscResource,
} from './asc.js';
import type { Boundary } from './boundary.js';
import { labelPrefixFor, type Config, type TargetConfig } from './config.js';
import { fail, type Project } from './project.js';
import { ascEntityName, bundleIdFor } from './variant.js';

/** Where Xcode reads installed profiles from. */
export const profileDirectory = (boundary: Boundary): string =>
  join(boundary.homedir(), 'Library', 'MobileDevice', 'Provisioning Profiles');

export interface ProvisionedProfile {
  target: string;
  bundleId: string;
  profileName: string;
  /** Absolute path of the installed `.mobileprovision`. */
  installedAt: string;
  uuid: string;
}

export interface ProvisionOptions {
  suffix: string;
  displayName: string;
  /** `IOS_APP_DEVELOPMENT` for a cabled install, `IOS_APP_ADHOC` for OTA. */
  profileType?: string;
}

const errorText = (status: number, body: unknown): string => `${status} ${describeAscError(body)}`;

/** Register the bundle id if it is not there already, and return its row id. */
export async function ensureBundleId(
  client: AscClient,
  identifier: string,
  name: string,
): Promise<string> {
  const existing = await client.request<AscDocument>(
    'GET',
    `/v1/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=5`,
  );
  if (existing.status === 200) {
    // Apple's filter matches by prefix, so an exact comparison is required —
    // otherwise `…dev.wave` matches when only `…dev.wavelength` exists.
    const match = asArray(existing.body.data).find(
      (row) => row.attributes.identifier === identifier,
    );
    if (match) return match.id;
  }

  const created = await client.request<AscDocument>('POST', '/v1/bundleIds', {
    data: {
      type: 'bundleIds',
      attributes: { identifier, name, platform: 'IOS' },
    },
  });
  if (created.status !== 201) {
    fail(
      `could not register the bundle id ${identifier}: ${errorText(created.status, created.body)}`,
    );
  }
  const row = asArray(created.body.data)[0];
  if (!row) fail(`App Store Connect registered ${identifier} but returned no id`);
  return row.id;
}

export async function ensureCapabilities(
  client: AscClient,
  bundleRowId: string,
  capabilities: string[],
): Promise<void> {
  for (const capability of capabilities) {
    const result = await client.request<AscDocument>('POST', '/v1/bundleIdCapabilities', {
      data: {
        type: 'bundleIdCapabilities',
        attributes: { capabilityType: capability },
        relationships: { bundleId: { data: { type: 'bundleIds', id: bundleRowId } } },
      },
    });
    // 409 means it is already enabled, or implied by another capability.
    if (![200, 201, 409].includes(result.status)) {
      fail(`could not enable ${capability}: ${errorText(result.status, result.body)}`);
    }
  }
}

/**
 * The development certificate whose private key is actually in this keychain.
 * The account may hold certificates belonging to other machines; signing with
 * one of those fails at build time with an error that names nothing useful.
 */
export async function localDevelopmentCertificateId(
  boundary: Boundary,
  client: AscClient,
): Promise<string> {
  const identities = boundary.exec.runSync('security', [
    'find-identity',
    '-v',
    '-p',
    'codesigning',
  ]);
  const certificates = await client.request<AscDocument>(
    'GET',
    '/v1/certificates?filter[certificateType]=DEVELOPMENT&limit=50',
  );
  if (certificates.status !== 200) {
    fail(
      `could not list signing certificates: ${errorText(certificates.status, certificates.body)}`,
    );
  }
  const match = asArray(certificates.body.data).find((certificate) => {
    const displayName = certificate.attributes.displayName;
    return typeof displayName === 'string' && identities.stdout.includes(displayName);
  });
  if (!match) {
    fail(
      'no App Store Connect development certificate matches a signing identity in this keychain.\n' +
        '  Create one in Xcode once (Settings › Accounts › Manage Certificates), or import the\n' +
        "  existing certificate's private key into this keychain.",
    );
  }
  return match.id;
}

export async function enabledDeviceIds(client: AscClient): Promise<string[]> {
  const devices = await client.request<AscDocument>(
    'GET',
    '/v1/devices?filter[platform]=IOS&filter[status]=ENABLED&limit=200',
  );
  if (devices.status !== 200) {
    fail(`could not list registered devices: ${errorText(devices.status, devices.body)}`);
  }
  return asArray(devices.body.data).map((device) => device.id);
}

/**
 * A `.mobileprovision` is a CMS envelope wrapping a plist. Only the UUID is
 * needed, and it is the filename Xcode expects — so the embedded plist is
 * sliced out and read rather than pulling in a CMS parser.
 */
export function profileUuid(contents: Uint8Array): string {
  const text = Buffer.from(contents).toString('binary');
  const start = text.indexOf('<?xml');
  const end = text.indexOf('</plist>');
  if (start === -1 || end === -1)
    fail('the profile App Store Connect returned has no plist inside');
  const plist = text.slice(start, end + '</plist>'.length);
  const uuid = /<key>UUID<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  if (!uuid) fail('the profile App Store Connect returned carries no UUID');
  return uuid;
}

export async function ensureProfile(
  boundary: Boundary,
  client: AscClient,
  options: {
    name: string;
    bundleRowId: string;
    certificateId: string;
    deviceIds: string[];
    profileType: string;
  },
): Promise<{ uuid: string; installedAt: string }> {
  const existing = await client.request<AscDocument>(
    'GET',
    `/v1/profiles?filter[name]=${encodeURIComponent(options.name)}&limit=5`,
  );
  if (existing.status === 200) {
    for (const row of asArray(existing.body.data)) {
      if (row.attributes.name === options.name) {
        await client.request('DELETE', `/v1/profiles/${row.id}`);
      }
    }
  }

  const created = await client.request<AscDocument>('POST', '/v1/profiles', {
    data: {
      type: 'profiles',
      attributes: { name: options.name, profileType: options.profileType },
      relationships: {
        bundleId: { data: { type: 'bundleIds', id: options.bundleRowId } },
        certificates: { data: [{ type: 'certificates', id: options.certificateId }] },
        devices: { data: options.deviceIds.map((id) => ({ type: 'devices', id })) },
      },
    },
  });
  if (created.status !== 201) {
    fail(
      `could not create the profile "${options.name}": ${errorText(created.status, created.body)}`,
    );
  }

  const row = asArray(created.body.data)[0] as AscResource | undefined;
  const encoded = row?.attributes.profileContent;
  if (typeof encoded !== 'string') fail(`the profile "${options.name}" came back empty`);
  const contents = Buffer.from(encoded, 'base64');
  const uuid = profileUuid(contents);
  const installedAt = join(profileDirectory(boundary), `${uuid}.mobileprovision`);
  boundary.fs.write(installedAt, new Uint8Array(contents));
  return { uuid, installedAt };
}

/** `<base>.<slug>` for the app; the app's id plus one segment for an extension. */
export function targetBundleId(target: TargetConfig, suffix: string, config: Config): string {
  const appId = bundleIdFor(suffix, config);
  return target.bundleIdSuffix ? `${appId}.${target.bundleIdSuffix}` : appId;
}

/**
 * The App Store Connect entity name for a target. Derived from the home-screen
 * label so there is one spelling of the convention — the extension gets the
 * app's name plus its own, which is what makes a list of bundle ids readable.
 */
export function targetEntityName(target: TargetConfig, displayName: string): string {
  return ascEntityName(target.bundleIdSuffix ? `${displayName} ${target.name}` : displayName);
}

export function profileNameFor(target: TargetConfig, suffix: string, config: Config): string {
  const prefix = config.variant.profilePrefix ?? labelPrefixFor(config);
  return `${prefix} ${suffix} ${target.bundleIdSuffix ?? 'app'}`;
}

/**
 * Register everything a variant needs and install its profiles. Returns one
 * entry per target, in configuration order, for the build to sign against.
 */
export async function provisionVariant(
  boundary: Boundary,
  project: Project,
  options: ProvisionOptions,
): Promise<ProvisionedProfile[]> {
  const { config } = project;
  const targets = config.variant.targets;
  if (targets.length === 0) {
    fail(
      'a variant build needs at least one entry in variant.targets — the app itself, and any ' +
        'extension that ships inside it.',
    );
  }
  if (!options.suffix) fail('provisionVariant needs a variant slug');

  const client = connect(boundary, config);
  const profileType = options.profileType ?? 'IOS_APP_DEVELOPMENT';

  const registered: Array<{ target: TargetConfig; bundleId: string; rowId: string }> = [];
  for (const target of targets) {
    const bundleId = targetBundleId(target, options.suffix, config);
    boundary.log.step(`provisioning ${bundleId}`);
    const rowId = await ensureBundleId(
      client,
      bundleId,
      targetEntityName(target, options.displayName),
    );
    await ensureCapabilities(client, rowId, target.capabilities);
    registered.push({ target, bundleId, rowId });
  }

  // One certificate and one device list for every profile in the run: they are
  // the same answer each time, and each lookup is a round trip to Apple.
  const certificateId = await localDevelopmentCertificateId(boundary, client);
  const deviceIds = await enabledDeviceIds(client);
  if (deviceIds.length === 0) {
    fail(
      'no enabled iOS devices are registered on this team, so a profile would install nowhere.\n' +
        '  Register the device once (plug it in and build from Xcode), then re-run.',
    );
  }

  const profiles: ProvisionedProfile[] = [];
  for (const { target, bundleId, rowId } of registered) {
    const profileName = profileNameFor(target, options.suffix, config);
    const { uuid, installedAt } = await ensureProfile(boundary, client, {
      name: profileName,
      bundleRowId: rowId,
      certificateId,
      deviceIds,
      profileType,
    });
    profiles.push({ target: target.name, bundleId, profileName, installedAt, uuid });
  }
  return profiles;
}
