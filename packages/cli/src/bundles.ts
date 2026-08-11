/**
 * What this project has registered with Apple, and how to get rid of it.
 *
 * Every `--suffix` install mints permanent account state: a bundle id, one more
 * for each extension, and a provisioning profile apiece. Nothing ever removed
 * them, so they accrue — one set per branch anyone ever tested, plus one per
 * typo.
 *
 * DELETION IS IRREVERSIBLE AND APPLE RESTORES NOTHING, so a dry run is the
 * DEFAULT everywhere: the plan is printed, nothing is sent, and the command
 * succeeds. `yes` executes. Nothing here ever prompts — an agent or a piped
 * session has no terminal to answer with, and the absence of `yes` is already
 * an unambiguous answer.
 *
 * The base bundle id is protected twice over: `groupVariants` never classifies
 * it as a variant, and `assertDeletable` checks again immediately before every
 * DELETE. Losing it breaks signing for every build this project ever makes.
 */
import { asArray, connect, type AscClient, type AscDocument } from './asc.js';
import type { Boundary } from './boundary.js';
import { resolveTargets, type ResolvedTarget } from './bundle-ids.js';
import { labelPrefixFor, type Config } from './config.js';
import { fail, type Project } from './project.js';
import { provisionVariant, type ProvisionedProfile } from './provision.js';
import { sanitizeSuffix } from './variant.js';

export interface RegisteredBundleId {
  id: string;
  identifier: string;
  name: string;
}

export interface RegisteredProfile {
  id: string;
  name: string;
  /** ISO 8601, as Apple returns it. Empty when the account did not say. */
  createdDate: string;
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
export function protectedBundleIds(targets: ResolvedTarget[], config: Config): Set<string> {
  const base = config.project.baseBundleId;
  return new Set([
    base,
    ...targets
      .filter((target) => target.bundleIdSuffix)
      .map((target) => `${base}.${target.bundleIdSuffix}`),
  ]);
}

/** Last line of defence: called immediately before every DELETE. */
export function assertDeletable(
  identifier: string,
  protectedIds: Set<string>,
  config: Config,
): void {
  const base = config.project.baseBundleId;
  if (protectedIds.has(identifier)) {
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
    createdDate: String(row.attributes.createdDate ?? ''),
  }));
}

/**
 * Group the account's flat lists into variants.
 *
 * A variant's app id is `<base>.<slug>` where `<slug>` is ONE segment and is not
 * a configured extension suffix. That second clause is load-bearing:
 * `<base>.uploadwidget` is the extension every plain build ships, a sibling of
 * the base rather than a variant, and it passes the single-segment test. Without
 * the exclusion, pruning deletes it and plain builds stop signing. A variant's
 * OWN extension is `<base>.<slug>.uploadwidget` — two segments, so it is never
 * mistaken for a variant of its own.
 */
export function groupVariants(
  bundleIds: RegisteredBundleId[],
  profiles: RegisteredProfile[],
  config: Config,
  protectedIds: Set<string>,
): RegisteredVariant[] {
  const prefix = `${config.project.baseBundleId}.`;
  const profilePrefix = labelPrefixFor(config);

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

/**
 * Everything this project has registered, in one round trip pair.
 *
 * `quiet` exists for `ls --json`, whose stdout is a bare array that predates the
 * event stream and has to stay exactly that. A step event would land in the
 * middle of it, so that one caller reports through the plain logger instead.
 */
export async function readAccount(
  boundary: Boundary,
  project: Project,
  options: { quiet?: boolean } = {},
): Promise<{ client: AscClient; variants: RegisteredVariant[] }> {
  const client = connect(boundary, project.config);
  const read = (): Promise<[RegisteredBundleId[], RegisteredProfile[]]> =>
    Promise.all([fetchBundleIds(client), fetchProfiles(client)]);
  let bundleIds: RegisteredBundleId[];
  let profiles: RegisteredProfile[];
  if (options.quiet) {
    boundary.log.step('reading the developer account');
    [bundleIds, profiles] = await read();
  } else {
    [bundleIds, profiles] = await boundary.report.run('account', 'read the account', read);
  }
  const protectedIds = protectedBundleIds(resolveTargets(boundary, project), project.config);
  return { client, variants: groupVariants(bundleIds, profiles, project.config, protectedIds) };
}

/* -------------------------------------------------------------------------- */
/* ls                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * When this variant first appeared.
 *
 * Taken from the earliest profile, because App Store Connect does not date a
 * bundle id at all — the resource carries only its identifier, name, platform
 * and seed id. A variant with no profile left therefore has no date to show.
 */
export function firstSeen(variant: RegisteredVariant): string {
  const dates = variant.profiles
    .map((profile) => profile.createdDate)
    .filter(Boolean)
    .sort();
  return dates[0]?.slice(0, 10) ?? '—';
}

export interface VariantRecord {
  slug: string;
  bundleId: string;
  name: string;
  extensions: string[];
  profileCount: number;
  /** `YYYY-MM-DD` of the earliest profile, or null when none is left. */
  created: string | null;
}

export const toRecords = (variants: RegisteredVariant[]): VariantRecord[] =>
  variants.map((variant) => ({
    slug: variant.suffix,
    bundleId: variant.app.identifier,
    name: variant.app.name,
    extensions: variant.extensions.map((extension) => extension.identifier),
    profileCount: variant.profiles.length,
    created: firstSeen(variant) === '—' ? null : firstSeen(variant),
  }));

const COLUMNS = ['SLUG', 'BUNDLE ID', 'PROFILES', 'CREATED'] as const;

/**
 * One line per variant, columns padded to the widest cell. The header is always
 * printed, even with nothing to list, so a script can parse the shape of the
 * output without special-casing "empty".
 */
export function renderTable(variants: RegisteredVariant[]): string {
  const rows = variants.map((variant) => [
    variant.suffix,
    variant.app.identifier,
    String(variant.profiles.length),
    firstSeen(variant),
  ]);
  const widths = COLUMNS.map((heading, column) =>
    Math.max(heading.length, ...rows.map((row) => row[column]!.length), 0),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column]!)))
      .join('  ');
  return [line(COLUMNS), ...rows.map(line)].join('\n');
}

/**
 * The listing.
 *
 * The payload goes to STDOUT — every human line is stderr, and `bundles ls
 * --json | jq` has to receive something. With `--json` that payload is the whole
 * of stdout: one array, not an event stream, because scripts already parse it
 * that way. It is also returned, so the shape is testable without scraping a
 * stream.
 */
export async function listBundles(
  boundary: Boundary,
  project: Project,
  options: { json?: boolean } = {},
): Promise<string> {
  const { variants } = await readAccount(boundary, project, { quiet: options.json });
  if (variants.length === 0 && !options.json) {
    boundary.log.info(`no variants of ${project.config.project.baseBundleId} are registered.`);
  }
  const output = options.json
    ? JSON.stringify(toRecords(variants), null, 2)
    : renderTable(variants);
  boundary.report.write(output);
  return output;
}

/* -------------------------------------------------------------------------- */
/* removal                                                                    */
/* -------------------------------------------------------------------------- */

function describe(variant: RegisteredVariant, reason?: string): string[] {
  const lines = [
    `  ${variant.app.identifier}  "${variant.app.name}"${reason ? ` — ${reason}` : ''}`,
  ];
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
  protectedIds: Set<string>,
  variant: RegisteredVariant,
): Promise<void> {
  // Re-checked here, at the point of no return, rather than trusting whatever
  // selected this variant three functions ago.
  assertDeletable(variant.app.identifier, protectedIds, config);
  for (const extension of variant.extensions)
    assertDeletable(extension.identifier, protectedIds, config);

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

export interface RemovalResult {
  /** Slugs that were, or would have been, removed. */
  slugs: string[];
  /** True when nothing was sent — the default. */
  dryRun: boolean;
}

/** The shared tail of `rm` and `prune`: print the plan, then stop or delete. */
async function removeSelected(
  boundary: Boundary,
  client: AscClient,
  project: Project,
  selected: Array<{ variant: RegisteredVariant; reason?: string }>,
  yes: boolean,
): Promise<RemovalResult> {
  const report = boundary.report;
  report.note(
    yes
      ? 'deleting from the Apple Developer account:'
      : 'would delete from the Apple Developer account:',
  );
  for (const { variant, reason } of selected) {
    report.note(describe(variant, reason).join('\n'));
  }
  report.emit('plan', {
    dryRun: !yes,
    variants: selected.map(({ variant, reason }) => ({
      slug: variant.suffix,
      bundleId: variant.app.identifier,
      name: variant.app.name,
      extensions: variant.extensions.map((extension) => extension.identifier),
      profiles: variant.profiles.map((profile) => profile.name),
      ...(reason ? { reason } : {}),
    })),
  });

  const slugs = selected.map(({ variant }) => variant.suffix);
  if (!yes) {
    report.warn(
      `dry run — nothing was deleted. Re-run with -y to remove ${slugs.length} variant(s).`,
    );
    report.done(true, { removed: 0, dryRun: true, slugs });
    return { slugs, dryRun: true };
  }

  const protectedIds = protectedBundleIds(resolveTargets(boundary, project), project.config);
  for (const { variant } of selected) {
    await report.run('remove', variant.suffix, async (step) => {
      step.detail(variant.app.identifier);
      step.data({ slug: variant.suffix, bundleId: variant.app.identifier });
      await deleteVariant(boundary, client, project.config, protectedIds, variant);
    });
  }
  report.done(true, { removed: slugs.length, dryRun: false, slugs });
  return { slugs, dryRun: false };
}

export async function removeBundles(
  boundary: Boundary,
  project: Project,
  options: { suffixes: string[]; yes?: boolean },
): Promise<RemovalResult> {
  if (options.suffixes.length === 0) {
    fail(
      'name at least one variant to remove.\n' +
        '  `jetbridge bundles ls` shows what is registered; `bundles prune` removes the stale ones.',
    );
  }

  boundary.report.start({
    command: 'bundles rm',
    data: { slugs: options.suffixes, yes: Boolean(options.yes) },
    title: ['bundles rm', options.suffixes.join(', ')],
  });

  const { client, variants } = await readAccount(boundary, project);
  const selected = options.suffixes.map((slug) => {
    const variant = variants.find((candidate) => candidate.suffix === slug);
    if (!variant) {
      fail(
        `no variant "${slug}" is registered — nothing was deleted.\n` +
          `  Registered: ${variants.map((candidate) => candidate.suffix).join(', ') || '(none)'}`,
      );
    }
    return { variant };
  });

  return removeSelected(boundary, client, project, selected, Boolean(options.yes));
}

/* -------------------------------------------------------------------------- */
/* prune                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The slug of every branch that still exists on the remote.
 *
 * A slug is derived from a branch name by `sanitizeSuffix`, which is lossy —
 * `feat/seeded-feed` and `seeded_feed` both collapse to `seededfeed`. So the
 * branch names are pushed through the SAME function and compared as slugs,
 * rather than trying to invert a slug back into a branch name, which cannot be
 * done.
 *
 * `ls-remote` rather than a local branch list: a branch nobody on this machine
 * ever fetched is still alive, and reading it as dead would delete a colleague's
 * variant.
 */
export async function liveBranchSlugs(boundary: Boundary, project: Project): Promise<Set<string>> {
  const inRepo = await boundary.exec.run('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: project.root,
    allowFail: true,
  });
  // Exit 0 is not enough: inside a `.git` directory, or with GIT_DIR set, git
  // succeeds and prints `false`.
  if (!inRepo.ok || inRepo.stdout.trim() !== 'true') {
    fail(
      'prune decides what is stale from the branches on the remote, and this is not a git ' +
        'checkout.\n  Remove them by name instead: `jetbridge bundles rm <slug>`.',
    );
  }

  const remote = await boundary.exec.run(
    'git',
    ['ls-remote', '--heads', project.config.git.remote],
    {
      cwd: project.root,
      allowFail: true,
    },
  );
  // Refusing here is the whole safety property. Unreachable must never read as
  // "every branch is gone", which would take the entire account with it.
  if (!remote.ok) {
    fail(
      'could not reach the git remote, so prune cannot tell which branches are gone.\n' +
        `  ${(remote.stderr || remote.stdout).trim().split('\n').slice(-3).join('\n  ')}\n` +
        '  Nothing was deleted. Reconnect and re-run, or name them with `bundles rm <slug>`.',
    );
  }

  const branches = remote.stdout
    .split('\n')
    .map((line) => /\srefs\/heads\/(.+)$/.exec(line.trim())?.[1])
    .filter((branch): branch is string => Boolean(branch));
  // A repository with no branches at all is not a real answer either — far more
  // likely a remote that replied with something this does not understand.
  if (branches.length === 0) {
    fail(
      'the git remote reported no branches at all, which would mark every variant stale.\n' +
        '  Nothing was deleted. Check `git ls-remote --heads origin` by hand.',
    );
  }

  const slugs = new Set<string>();
  for (const branch of branches) {
    try {
      slugs.add(sanitizeSuffix(branch, project.config));
    } catch {
      // A ref with no letters or digits names no variant; it just is not one.
    }
  }
  return slugs;
}

export async function pruneBundles(
  boundary: Boundary,
  project: Project,
  options: { yes?: boolean } = {},
): Promise<RemovalResult> {
  boundary.report.start({
    command: 'bundles prune',
    data: { yes: Boolean(options.yes) },
    title: ['bundles prune', project.config.project.baseBundleId],
  });

  // Before the account read: being offline is the answer either way, and it
  // costs nothing to find out first.
  const live = await liveBranchSlugs(boundary, project);
  const { client, variants } = await readAccount(boundary, project);

  const stale = variants.filter((variant) => !live.has(variant.suffix));
  const kept = variants.length - stale.length;
  boundary.report.note(
    `${variants.length} variant(s) registered, ${kept} with a branch still on the remote.`,
  );
  if (stale.length === 0) {
    boundary.report.note('nothing to prune.');
    boundary.report.done(true, { removed: 0, dryRun: false, slugs: [] });
    return { slugs: [], dryRun: false };
  }

  return removeSelected(
    boundary,
    client,
    project,
    stale.map((variant) => ({ variant, reason: 'no branch on the remote maps to this slug' })),
    Boolean(options.yes),
  );
}

/* -------------------------------------------------------------------------- */
/* provision                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Register a variant and mint its profiles without building anything.
 *
 * The only route to a refresh after a certificate rotation or a newly registered
 * phone that does not also cost a full build.
 */
export async function provisionBundles(
  boundary: Boundary,
  project: Project,
  options: { suffix: string; displayName: string },
): Promise<ProvisionedProfile[]> {
  const { suffix, displayName } = options;
  if (!suffix) {
    fail(
      'name the variant to provision, e.g. `jetbridge bundles provision wave`.\n' +
        '  A plain build signs against the profile the project already has — there is nothing\n' +
        '  for this command to register.',
    );
  }
  boundary.report.start({
    command: 'bundles provision',
    data: { suffix, displayName },
    title: ['bundles provision', suffix],
  });
  const profiles = await boundary.report.run('provision', 'provisioned', async (step) => {
    const minted = await provisionVariant(boundary, project, { suffix, displayName });
    step.detail(minted.map((profile) => profile.profileName).join(' + '));
    step.data({
      profiles: minted.map((profile) => ({
        target: profile.target,
        bundleId: profile.bundleId,
        name: profile.profileName,
        installedAt: profile.installedAt,
      })),
    });
    return minted;
  });
  boundary.report.done(true, { profiles: profiles.length });
  return profiles;
}
