/**
 * Signing: the build settings that point a variant build at its profiles, and
 * the on-disk cache that lets a repeat install skip provisioning entirely.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Boundary } from './boundary.js';
import type { Config, TargetConfig } from './config.js';
import { profileDirectory, profileNameFor } from './provision.js';

export interface SigningProfiles {
  /** Target name → provisioning profile name. */
  byTarget: Record<string, string>;
}

/** `JETBRIDGE_PROFILE_APP` for the app, `JETBRIDGE_PROFILE_UPLOADWIDGET` for an extension. */
export function profileSettingName(target: TargetConfig): string {
  const key = (target.bundleIdSuffix ?? 'app').toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `JETBRIDGE_PROFILE_${key}`;
}

/** Build settings that put the build on manual signing against our profiles. */
export function signSettings(suffix: string, profiles: SigningProfiles, config: Config): string[] {
  // No variant means the project's own automatic signing, untouched.
  if (!suffix) return [];
  const settings = ['JETBRIDGE_SIGN_STYLE=Manual'];
  for (const target of config.variant.targets) {
    const profile = profiles.byTarget[target.name];
    if (profile) settings.push(`${profileSettingName(target)}=${profile}`);
  }
  return settings;
}

/** The bundle-id suffix and home-screen label, as build settings. */
export function variantSettings(suffix: string, displayName: string): string[] {
  return [
    ...(suffix ? [`JETBRIDGE_SUFFIX=.${suffix}`] : []),
    ...(displayName ? [`JETBRIDGE_DISPLAY_NAME=${displayName}`] : []),
  ];
}

interface ParsedProfile {
  name: string;
  expiresMs: number;
  devices: Set<string>;
  certificateSha1: Set<string>;
}

/** The few fields that decide whether a cached profile can still sign. */
export function parseProfilePlist(xml: string): ParsedProfile | null {
  const name = /<key>Name<\/key>\s*<string>([^<]*)<\/string>/.exec(xml)?.[1];
  const expires = /<key>ExpirationDate<\/key>\s*<date>([^<]*)<\/date>/.exec(xml)?.[1];
  if (!name || !expires) return null;

  const devices = new Set<string>();
  const deviceBlock = /<key>ProvisionedDevices<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1];
  for (const match of (deviceBlock ?? '').matchAll(/<string>([^<]+)<\/string>/g)) {
    devices.add(match[1]!);
  }

  const certificateSha1 = new Set<string>();
  const certificateBlock = /<key>DeveloperCertificates<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(
    xml,
  )?.[1];
  for (const match of (certificateBlock ?? '').matchAll(/<data>([\s\S]*?)<\/data>/g)) {
    const der = Buffer.from(match[1]!.replace(/\s+/g, ''), 'base64');
    certificateSha1.add(createHash('sha1').update(der).digest('hex').toUpperCase());
  }
  return { name, expiresMs: Date.parse(expires), devices, certificateSha1 };
}

/** SHA-1 thumbprints of every codesigning identity whose key is in this keychain. */
export function localSigningThumbprints(boundary: Boundary): Set<string> {
  const output = boundary.exec.runSync('security', [
    'find-identity',
    '-v',
    '-p',
    'codesigning',
  ]).stdout;
  const thumbprints = new Set<string>();
  for (const match of output.matchAll(/\b([0-9A-F]{40})\b/g)) thumbprints.add(match[1]!);
  return thumbprints;
}

/** A profile within this long of expiry is treated as already expired. */
const EXPIRY_MARGIN_MS = 24 * 60 * 60 * 1000;

/**
 * The fast path around provisioning: if valid profiles for this variant are
 * already installed, skip the round trips to Apple.
 *
 * A profile only counts when every one of these holds, so a stale one never
 * silently signs a build that then refuses to install:
 *   - its name is what the provisioner mints, for every target;
 *   - it is not within a day of expiring;
 *   - it covers every device this install targets (a newly registered phone is
 *     a miss, and provisioning adds it);
 *   - it embeds a certificate whose private key is in this keychain, which is
 *     what closes the certificate-rotation hole.
 *
 * Any parse or tool hiccup returns null: the caller then provisions, which is
 * the correct outcome, just slower.
 */
export function cachedSigning(
  boundary: Boundary,
  config: Config,
  options: { suffix: string; deviceUdids: string[]; now: number },
): SigningProfiles | null {
  try {
    const directory = profileDirectory(boundary);
    if (!boundary.fs.exists(directory)) return null;
    const identities = localSigningThumbprints(boundary);
    if (identities.size === 0) return null;

    const wanted = new Map(
      config.variant.targets.map((target) => [
        profileNameFor(target, options.suffix, config),
        target.name,
      ]),
    );
    if (wanted.size === 0) return null;
    if (options.deviceUdids.length === 0 || options.deviceUdids.some((udid) => !udid)) return null;

    const found: Record<string, string> = {};
    for (const file of boundary.fs.readdir(directory)) {
      if (!file.endsWith('.mobileprovision')) continue;
      if (Object.keys(found).length === wanted.size) break;

      const decoded = boundary.exec.runSync('security', ['cms', '-D', '-i', join(directory, file)]);
      if (!decoded.ok) continue;
      const parsed = parseProfilePlist(decoded.stdout);
      if (!parsed) continue;

      const targetName = wanted.get(parsed.name);
      if (!targetName) continue;
      if (Number.isNaN(parsed.expiresMs)) continue;
      if (parsed.expiresMs - options.now * 1000 < EXPIRY_MARGIN_MS) continue;
      if (!options.deviceUdids.every((udid) => parsed.devices.has(udid))) continue;
      if (![...parsed.certificateSha1].some((sha) => identities.has(sha))) continue;

      found[targetName] = parsed.name;
    }

    return Object.keys(found).length === wanted.size ? { byTarget: found } : null;
  } catch {
    return null;
  }
}
