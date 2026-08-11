/**
 * Which App Store Connect capabilities a target's bundle id needs.
 *
 * Derived from the entitlements file the target already points at, never
 * declared a second time in the config. A hand-kept list drifts silently: the
 * config says PUSH_NOTIFICATIONS, someone edits the entitlements, and nothing
 * notices until a build signs against a profile that is missing a capability.
 */
import type { Boundary } from './boundary.js';
import type { TargetConfig } from './config.js';
import { readPlistFile } from './plist.js';
import { fail, type Project } from './project.js';

/**
 * Entitlement key → capability type, in the order jetbridge enables them.
 *
 * Only the KEY matters: an entitlement's value says which environment or which
 * group, never whether the capability is on. Apple keeps adding entitlements,
 * so anything not listed here is skipped rather than guessed at — an
 * unrecognised key must never fail a build.
 */
export const CAPABILITY_BY_ENTITLEMENT: ReadonlyArray<readonly [string, string]> = [
  ['aps-environment', 'PUSH_NOTIFICATIONS'],
  ['com.apple.developer.associated-domains', 'ASSOCIATED_DOMAINS'],
  ['com.apple.security.application-groups', 'APP_GROUPS'],
  ['com.apple.developer.applesignin', 'APPLE_ID_AUTH'],
  ['com.apple.developer.icloud-container-identifiers', 'ICLOUD'],
  ['com.apple.developer.siri', 'SIRIKIT'],
  ['com.apple.developer.healthkit', 'HEALTHKIT'],
  ['com.apple.developer.homekit', 'HOMEKIT'],
  ['com.apple.developer.in-app-payments', 'APPLE_PAY'],
  ['com.apple.developer.game-center', 'GAME_CENTER'],
  ['com.apple.developer.nfc.readersession.formats', 'NFC_TAG_READING'],
  ['com.apple.developer.networking.vpn.api', 'PERSONAL_VPN'],
  ['com.apple.developer.networking.wifi-info', 'ACCESS_WIFI_INFORMATION'],
  ['inter-app-audio', 'INTER_APP_AUDIO'],
  ['com.apple.developer.networking.multipath', 'MULTIPATH'],
  ['com.apple.developer.default-data-protection', 'DATA_PROTECTION'],
  ['wireless-accessory-configuration', 'WIRELESS_ACCESSORY_CONFIGURATION'],
];

/**
 * The capabilities the public App Store Connect API cannot turn on for a
 * freshly registered bundle id, because each one needs a related identifier
 * that only a person with the developer account can attach — an app group, or
 * the primary app id a Sign in with Apple grouping hangs off.
 *
 * They are exactly the reason `variantEntitlements` exists: a variant that
 * keeps them signs against a profile that does not carry them, and the build
 * fails at signing. Kept deliberately short — a capability wrongly named here
 * warns about a variant that would have provisioned fine.
 */
export const UNGRANTABLE_CAPABILITIES: readonly string[] = ['APP_GROUPS', 'APPLE_ID_AUTH'];

/**
 * The capabilities an entitlements file declares, or null when it is missing or
 * is not a property list. Never throws: the wizard reads a project it has not
 * validated, and a strange file there is a warning, not the end of the run.
 */
export function capabilitiesInEntitlements(boundary: Boundary, path: string): string[] | null {
  if (!boundary.fs.exists(path)) return null;
  let entitlements: Record<string, unknown> | null;
  try {
    entitlements = readPlistFile(boundary, path);
  } catch {
    return null;
  }
  if (!entitlements) return null;
  return CAPABILITY_BY_ENTITLEMENT.filter(([key]) => key in entitlements).map(
    ([, capability]) => capability,
  );
}

/**
 * The entitlements a VARIANT signs against, which is the file that decides what
 * to ask Apple for. A variant deliberately drops what the public API cannot
 * grant, so deriving from the shipping file would request capabilities Apple
 * refuses — and the request, not the build, is what fails.
 */
export const entitlementsPathFor = (target: TargetConfig, shipping?: string): string | undefined =>
  target.variantEntitlements ?? shipping;

/**
 * Capabilities to enable on this target's registered bundle id.
 *
 * No entitlements file is the common case — an app with nothing special
 * declares none — so a missing path and a path that is not on disk both yield
 * an empty list. A file that IS there and does not parse fails the run: that is
 * a broken project, not an absent one, and provisioning it as capability-free
 * mints a profile that signs and then refuses to install.
 */
export function capabilitiesFor(
  boundary: Boundary,
  project: Project,
  target: TargetConfig,
  /** The target's shipping entitlements, as the project spells them. */
  shipping?: string,
): string[] {
  const relative = entitlementsPathFor(target, shipping);
  if (!relative) return [];
  const path = project.path(relative);
  if (!boundary.fs.exists(path)) return [];
  const capabilities = capabilitiesInEntitlements(boundary, path);
  if (!capabilities) {
    fail(`could not read ${target.name}'s entitlements at ${path} — it is not a property list`);
  }
  return capabilities;
}
