/**
 * Removing variants from the developer account.
 *
 * Every `--suffix` install mints permanent account state: a bundle id, one more
 * for each extension, and a provisioning profile apiece. Nothing ever removed
 * them, so they accrue — one set per branch anyone ever tested, plus one per
 * typo.
 *
 * DELETION IS IRREVERSIBLE AND APPLE RESTORES NOTHING, so a dry run is the
 * DEFAULT: it prints exactly what it would delete and stops. `yes` executes.
 *
 * The base bundle id is protected twice over: `groupVariants` never classifies
 * it as a variant, and `assertDeletable` checks again immediately before every
 * DELETE. Losing it breaks signing for every build this project ever makes.
 */
import { asArray, connect, type AscClient, type AscDocument } from './asc.js';
import type { Boundary } from './boundary.js';
import { labelPrefixFor, type Config } from './config.js';
import { fail, type Project } from './project.js';

export interface CleanOptions {
  /** Variant slugs to remove. Ignored when `all` is set. */
  suffixes?: string[];
  all?: boolean;
  /** Actually delete. Without it, the plan is printed and nothing is touched. */
  yes?: boolean;
}

export interface RegisteredBundleId {
  id: string;
  identifier: string;
  name: string;
}

export interface RegisteredProfile {
  id: string;
  name: string;
}

/** One variant and everything the account holds for it. */
export interface RegisteredVariant {
  suffix: string;
  app: RegisteredBundleId;
  extensions: RegisteredBundleId[];
  profiles: RegisteredProfile[];
}

/**
 * Identifiers this command must never delete, whatever the grouping believes:
 * the project's own bundle id, and the id of each extension that ships inside
 * the plain build. Both are single-segment children of the base — structurally
 * indistinguishable from a variant without this list.
 */
export function protectedBundleIds(config: Config): Set<string> {
  const base = config.project.baseBundleId;
  return new Set([
    base,
    ...config.variant.targets
      .filter((target) => target.bundleIdSuffix)
      .map((target) => `${base}.${target.bundleIdSuffix}`),
  ]);
}

/** Last line of defence: called immediately before every DELETE. */
export function assertDeletable(identifier: string, config: Config): void {
  const base = config.project.baseBundleId;
  if (protectedBundleIds(config).has(identifier)) {
    fail(
      `refusing to delete ${identifier} — it is a core identifier, not a variant.\n` +
        '  This is a bug: it should never have been selected. Nothing further was deleted.',
    );
  }
  if (!identifier.startsWith(`${base}.`)) {
    fail(
      `refusing to delete ${identifier} — it is not a "${base}.*" variant of this project.\n` +
        '  Remove it from the Apple Developer portal by hand if you really mean to.',
    );
  }
}

export async function fetchBundleIds(client: AscClient): Promise<RegisteredBundleId[]> {
  const result = await client.request<AscDocument>('GET', '/v1/bundleIds?limit=200');
  if (result.status !== 200) {
    fail(
      `could not list bundle ids (HTTP ${result.status}).\n` +
        '  Check that the App Store Connect key still has access to this team.',
    );
  }
  return asArray(result.body.data).map((row) => ({
    id: row.id,
    identifier: String(row.attributes.identifier ?? ''),
    name: String(row.attributes.name ?? ''),
  }));
}

export async function fetchProfiles(client: AscClient): Promise<RegisteredProfile[]> {
  const result = await client.request<AscDocument>('GET', '/v1/profiles?limit=200');
  if (result.status !== 200) {
    fail(
      `could not list provisioning profiles (HTTP ${result.status}).\n` +
        '  Check that the App Store Connect key still has access to this team.',
    );
  }
  return asArray(result.body.data).map((row) => ({
    id: row.id,
    name: String(row.attributes.name ?? ''),
  }));
}

/**
 * Group the account's flat lists into variants.
 *
 * A variant's app id is `<base>.<slug>` where `<slug>` is ONE segment and is not
 * a configured extension suffix. That second clause is load-bearing:
 * `<base>.uploadwidget` is the extension every plain build ships, a sibling of
 * the base rather than a variant, and it passes the single-segment test. Without
 * the exclusion, cleaning everything deletes it and plain builds stop signing. A
 * variant's OWN extension is `<base>.<slug>.uploadwidget` — two segments, so it
 * is never mistaken for a variant of its own.
 */
export function groupVariants(
  bundleIds: RegisteredBundleId[],
  profiles: RegisteredProfile[],
  config: Config,
): RegisteredVariant[] {
  const prefix = `${config.project.baseBundleId}.`;
  const protectedIds = protectedBundleIds(config);
  const profilePrefix = config.variant.profilePrefix ?? labelPrefixFor(config);

  return bundleIds
    .filter((bundle) => {
      if (protectedIds.has(bundle.identifier)) return false;
      if (!bundle.identifier.startsWith(prefix)) return false;
      const slug = bundle.identifier.slice(prefix.length);
      return slug.length > 0 && !slug.includes('.');
    })
    .map((app) => {
      const suffix = app.identifier.slice(prefix.length);
      return {
        suffix,
        app,
        extensions: bundleIds.filter((bundle) =>
          bundle.identifier.startsWith(`${app.identifier}.`),
        ),
        // Matched on the prefix rather than the exact names `profileNameFor`
        // mints, so a profile for a target that has since left the config is
        // still swept up with its bundle id.
        profiles: profiles.filter((profile) =>
          profile.name.startsWith(`${profilePrefix} ${suffix} `),
        ),
      };
    })
    .sort((a, b) => a.suffix.localeCompare(b.suffix));
}

function describe(variant: RegisteredVariant): string[] {
  const lines = [`  ${variant.app.identifier}  "${variant.app.name}"`];
  for (const extension of variant.extensions) lines.push(`    ${extension.identifier}`);
  for (const profile of variant.profiles) lines.push(`    profile: ${profile.name}`);
  if (variant.extensions.length === 0 && variant.profiles.length === 0) {
    lines.push('    (no extensions or profiles)');
  }
  return lines;
}

/**
 * Profiles, then extensions, then the app — the reverse of the order they were
 * created in. A bundle id with a live profile cannot be removed, and an app id
 * is the prefix of its extensions' ids.
 */
async function deleteVariant(
  boundary: Boundary,
  client: AscClient,
  config: Config,
  variant: RegisteredVariant,
): Promise<void> {
  // Re-checked here, at the point of no return, rather than trusting whatever
  // selected this variant three functions ago.
  assertDeletable(variant.app.identifier, config);
  for (const extension of variant.extensions) assertDeletable(extension.identifier, config);

  for (const profile of variant.profiles) {
    const result = await client.request('DELETE', `/v1/profiles/${profile.id}`);
    if (result.status !== 204) {
      boundary.log.warn(`profile "${profile.name}" was not deleted (HTTP ${result.status})`);
    }
  }
  for (const extension of variant.extensions) {
    const result = await client.request('DELETE', `/v1/bundleIds/${extension.id}`);
    if (result.status !== 204) {
      fail(
        `${extension.identifier} was not deleted (HTTP ${result.status}).\n` +
          '  Delete it in the Apple Developer portal, then re-run.',
      );
    }
  }
  const result = await client.request('DELETE', `/v1/bundleIds/${variant.app.id}`);
  if (result.status !== 204) {
    fail(
      `${variant.app.identifier} was not deleted (HTTP ${result.status}).\n` +
        '  A profile may still reference it — check the Apple Developer portal.',
    );
  }
}

export async function cleanVariants(
  boundary: Boundary,
  project: Project,
  options: CleanOptions,
): Promise<void> {
  const { config } = project;
  const client = connect(boundary, config);

  boundary.log.step('reading the developer account');
  const [bundleIds, profiles] = await Promise.all([fetchBundleIds(client), fetchProfiles(client)]);
  const registered = groupVariants(bundleIds, profiles, config);
  if (registered.length === 0) {
    boundary.log.info('no variant identifiers are registered — nothing to clean.');
    return;
  }

  const requested = options.suffixes ?? [];
  let selected: RegisteredVariant[];
  if (options.all) {
    selected = registered;
  } else if (requested.length > 0) {
    selected = requested.map((suffix) => {
      const hit = registered.find((variant) => variant.suffix === suffix);
      if (!hit) {
        fail(
          `no variant "${suffix}" is registered — nothing was deleted.\n` +
            `  Registered: ${registered.map((variant) => variant.suffix).join(', ')}`,
        );
      }
      return hit;
    });
  } else {
    boundary.log.info(
      `registered variants: ${registered.map((variant) => variant.suffix).join(', ')}`,
    );
    return fail(
      'name what to remove: `--suffix <slug>` (repeatable), or `--all` for every variant above.',
    );
  }

  boundary.log.info(
    options.yes
      ? 'deleting from the Apple Developer account:'
      : 'would delete from the Apple Developer account:',
  );
  for (const variant of selected) boundary.log.info(describe(variant).join('\n'));

  if (!options.yes) {
    boundary.log.warn(
      `dry run — nothing was deleted. Re-run with --yes to remove ${selected.length} variant(s).`,
    );
    return;
  }

  for (const variant of selected) {
    boundary.log.step(`deleting ${variant.app.identifier}`);
    await deleteVariant(boundary, client, config, variant);
    boundary.log.info(`removed ${variant.app.identifier}`);
  }
  boundary.log.info(`done — ${selected.length} variant(s) removed.`);
}
