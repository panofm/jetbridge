/**
 * Over-the-air delivery: archive, export an .ipa, upload it to a bucket, and
 * print a URL the phone can open in Safari.
 *
 * This is the path for when the phone is not on the desk. Everything it shares
 * with the cabled install — variant naming, provisioning, the entitlement swap
 * — is imported, not repeated. What is genuinely different is here: the archive
 * verb, the export, the metadata read back out of the archive, and the bucket.
 *
 * The order of the last two steps is the load-bearing part. The manifest is
 * fetched over HTTPS BEFORE any URL is printed, because a bucket that accepts
 * the upload and then serves 403 is the common misconfiguration and iOS reports
 * it only as "Cannot connect".
 */
import { join } from 'node:path';
import { fillTemplate, readTemplate } from './assets.js';
import type { Boundary } from './boundary.js';
import {
  authArgs,
  buildNumber,
  buildNumberDetail,
  generateProject,
  requireToolchain,
  runHook,
} from './build.js';
import type { Config, OtaConfig } from './config.js';
import { withEntitlementSwap } from './entitlements.js';
import {
  escapeHtml,
  itmsServicesUrl,
  renderExportOptionsPlist,
  renderManifestPlist,
} from './manifest.js';
import { fail, type Project } from './project.js';
import { provisionVariant, targetBundleId } from './provision.js';
import { signSettings, variantSettings, type SigningProfiles } from './signing.js';
import {
  createStore,
  credentials,
  objectKey,
  projectToken,
  publicUrl,
  verifyReachable,
  type ObjectStore,
  type S3Factory,
} from './storage.js';
import { bundleIdFor } from './variant.js';
import { scratchPath } from './wired.js';

/**
 * The profile a signed export needs.
 *
 * Every one of these installs over the air on the devices its profile names.
 * They differ in the CERTIFICATE they require, which is the whole reason the
 * choice is exposed: a development profile signs with the certificate every
 * developer already has, while ad hoc and in-house need a distribution
 * certificate the team may not have issued.
 */
const PROFILE_TYPES: Record<OtaConfig['exportMethod'], string> = {
  development: 'IOS_APP_DEVELOPMENT',
  'ad-hoc': 'IOS_APP_ADHOC',
  enterprise: 'IOS_APP_INHOUSE',
};

const IPA_NAME = 'app.ipa';
const REGISTRY_NAME = 'builds.json';

// ─── reading a plist ─────────────────────────────────────────────────────────

export type PlistValue = string | boolean | PlistValue[] | { [key: string]: PlistValue };

const decodeEntities = (text: string): string =>
  text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');

/**
 * A reader for the subset of plist XML Xcode writes.
 *
 * Shelling out to PlistBuddy for each of a dozen keys is a dozen processes, and
 * — the reason that matters here — it makes the metadata step untestable
 * without an archive on disk. Xcode's own output is `<key>`/`<string>` XML, so
 * a scanner over the tags reads it exactly.
 */
export function parsePlist(xml: string): Record<string, PlistValue> {
  const tag = /<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g;
  const start = xml.indexOf('<plist');
  if (start === -1) fail('that file is not a plist — it has no <plist> element');
  tag.lastIndex = start;

  interface Token {
    closing: boolean;
    name: string;
    selfClosing: boolean;
    /** Where the tag starts, so the text before it can be sliced out. */
    start: number;
    end: number;
  }

  const next = (): Token => {
    const match = tag.exec(xml);
    if (!match) fail('the plist ended in the middle of a value — it is truncated or malformed');
    return {
      closing: match[1] === '/',
      name: match[2]!,
      selfClosing: match[3] === '/',
      start: match.index,
      end: tag.lastIndex,
    };
  };

  /** Everything from here to the next tag — which is this element's close. */
  const textUntilClose = (from: number): string => decodeEntities(xml.slice(from, next().start));

  const parseValue = (name: string, selfClosing: boolean, from: number): PlistValue => {
    if (name === 'true' || name === 'false') {
      if (!selfClosing) next();
      return name === 'true';
    }
    if (name === 'dict') {
      const dict: Record<string, PlistValue> = {};
      for (;;) {
        const token = next();
        if (token.closing && token.name === 'dict') return dict;
        if (token.name !== 'key') fail(`unexpected <${token.name}> where a plist key was expected`);
        const key = textUntilClose(token.end);
        const valueToken = next();
        dict[key] = parseValue(valueToken.name, valueToken.selfClosing, valueToken.end);
      }
    }
    if (name === 'array') {
      const array: PlistValue[] = [];
      for (;;) {
        const token = next();
        if (token.closing && token.name === 'array') return array;
        array.push(parseValue(token.name, token.selfClosing, token.end));
      }
    }
    return selfClosing ? '' : textUntilClose(from);
  };

  next(); // the <plist> element itself
  const root = next();
  if (root.name !== 'dict') fail('the plist does not hold a dictionary at its root');
  const value = parseValue('dict', false, root.end);
  return value as Record<string, PlistValue>;
}

/** A dotted path through nested dictionaries; an array yields its first entry. */
export function plistString(root: PlistValue, path: string, fallback: string): string {
  let value: PlistValue | undefined = root;
  for (const segment of path.split('.')) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return fallback;
    value = (value as Record<string, PlistValue>)[segment];
    if (value === undefined) return fallback;
  }
  if (Array.isArray(value)) value = value[0];
  if (typeof value === 'boolean') return String(value);
  return typeof value === 'string' && value !== '' ? value : fallback;
}

// ─── build metadata ──────────────────────────────────────────────────────────

export interface BuildMetadata {
  appName: string;
  bundleId: string;
  version: string;
  build: string;
  versionTag: string;
  teamId: string;
  /** Certificate type only. The page is URL-gated, not secret — no serial. */
  signedBy: string;
  archs: string;
  minIos: string;
  sdk: string;
  xcodeBuild: string;
  configuration: string;
  branch: string;
  commit: string;
  dirty: boolean;
  variantBadge: string;
  /** `YYYY-MM-DD HH:MM:SS UTC`, from the boundary clock. */
  builtAt: string;
}

/** `Apple Distribution: Dev Eloper (ABCDE12345)` → `Apple Distribution`. */
const certificateType = (identity: string): string => identity.split(':')[0]!.trim() || 'unknown';

/** `YYYY-MM-DD HH:MM:SS UTC`. UTC, not local: a build page is read by other people. */
export const utcStamp = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toISOString().replace('T', ' ').replace(/\..+$/, ' UTC');

/** Branch, short SHA and whether the tree was dirty. Absent git is not an error. */
export async function gitProvenance(
  boundary: Boundary,
  root: string,
): Promise<{ branch: string; commit: string; dirty: boolean }> {
  const git = async (...args: string[]): Promise<string> => {
    const result = await boundary.exec.run('git', ['-C', root, ...args], { allowFail: true });
    return result.ok ? result.stdout.trim() : '';
  };
  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
  return {
    branch: branch === 'HEAD' || branch === '' ? 'detached HEAD' : branch,
    commit: (await git('rev-parse', '--short', 'HEAD')) || '—',
    // A dirty tree means the .ipa matches no commit. The page says so rather
    // than printing a SHA that quietly misrepresents what is installing.
    dirty: (await git('status', '--porcelain')) !== '',
  };
}

/**
 * Read a plist that may be in either format.
 *
 * The archive's own Info.plist is XML, but the one inside the built `.app` is a
 * BINARY property list — Xcode converts it at copy time. `plutil` reads both,
 * and is on every Mac that has Xcode, so the text scanner above only ever sees
 * XML. Returns null when neither path works, and the caller decides whether
 * that is fatal.
 */
export function readPlistFile(boundary: Boundary, path: string): Record<string, PlistValue> | null {
  const raw = boundary.fs.read(path);
  if (raw.includes('<plist')) return parsePlist(raw);
  const converted = boundary.exec.runSync('plutil', ['-convert', 'xml1', '-o', '-', path], {
    allowFail: true,
  });
  return converted.ok && converted.stdout.includes('<plist') ? parsePlist(converted.stdout) : null;
}

/**
 * Everything the install page claims, read back out of the archive that
 * produced the .ipa — so the page cannot describe a build that was not made.
 */
export async function archiveMetadata(
  boundary: Boundary,
  project: Project,
  options: { archivePath: string; suffix: string; configuration: string },
): Promise<BuildMetadata> {
  const archivePlist = join(options.archivePath, 'Info.plist');
  if (!boundary.fs.exists(archivePlist)) {
    fail(
      `the archive at ${options.archivePath} has no Info.plist — the archive step did not finish`,
    );
  }
  const archive = readPlistFile(boundary, archivePlist);
  if (!archive) {
    fail(
      `could not read ${archivePlist}.\n` +
        '  Check it with `plutil -p` — the bundle id and version of the build are read from it.',
    );
  }
  const properties = 'ApplicationProperties';

  const applicationPath = plistString(archive, `${properties}.ApplicationPath`, '');
  const appPlist = applicationPath
    ? join(options.archivePath, 'Products', applicationPath, 'Info.plist')
    : '';
  // The app's plist only supplies fields that already have a fallback, so an
  // unreadable one costs a row on the page, never the publish.
  const app =
    (appPlist && boundary.fs.exists(appPlist) ? readPlistFile(boundary, appPlist) : null) ?? {};

  const version = plistString(archive, `${properties}.CFBundleShortVersionString`, '0.0.0');
  const build = plistString(archive, `${properties}.CFBundleVersion`, '0');
  const provenance = await gitProvenance(boundary, project.root);

  return {
    appName: plistString(
      app,
      'CFBundleDisplayName',
      plistString(app, 'CFBundleName', project.config.variant.displayName),
    ),
    bundleId: plistString(
      archive,
      `${properties}.CFBundleIdentifier`,
      project.config.project.baseBundleId,
    ),
    version,
    build,
    versionTag: `v${version} · build ${build}`,
    teamId: plistString(archive, `${properties}.Team`, project.config.project.teamId),
    signedBy: certificateType(plistString(archive, `${properties}.SigningIdentity`, 'unknown')),
    archs: plistString(archive, `${properties}.Architectures`, 'arm64'),
    minIos: plistString(app, 'MinimumOSVersion', '—'),
    sdk: plistString(app, 'DTPlatformVersion', '—'),
    xcodeBuild: plistString(app, 'DTXcodeBuild', '—'),
    configuration: options.configuration,
    ...provenance,
    variantBadge: options.suffix ? `variant · ${options.suffix}` : 'plain',
    builtAt: utcStamp(boundary.now()),
  };
}

// ─── the registry and the pages ──────────────────────────────────────────────

/**
 * One row per uploaded build, kept in the bucket. It is the source of truth for
 * the index page, which is why the page can be rebuilt from bucket state alone
 * without re-archiving anything.
 */
export interface BuildRecord {
  /** `<bundleId>-<build>`: unique per variant and version, and a key segment. */
  buildId: string;
  appName: string;
  bundleId: string;
  version: string;
  build: string;
  versionTag: string;
  variantBadge: string;
  branch: string;
  commit: string;
  dirty: boolean;
  ipaSizeLabel: string;
  ipaSizeBytes: number;
  builtAt: string;
  /** ISO instant of the upload — the sort key. */
  uploadedAt: string;
}

export const buildIdFor = (meta: BuildMetadata): string => `${meta.bundleId}-${meta.build}`;

export const megabytes = (bytes: number): string => `${Math.floor(bytes / 1024 / 1024)} MB`;

const brandTitle = (config: Config, ota: OtaConfig): string =>
  ota.branding.title ?? config.variant.displayName;

/** Six-digit hex, so it drops straight into the template's CSS variable. */
const brandAccent = (ota: OtaConfig): string => ota.branding.accent ?? '#f4f0e6';

/** One card. Every developer-controlled value is escaped on the way in. */
function renderRow(record: BuildRecord, manifestUrl: string): string {
  const x = escapeHtml;
  const commit = record.dirty ? `${record.commit} (dirty)` : record.commit;
  return `    <div class="build">
      <div class="top">
        <span class="title">${x(record.appName)}</span>
        <span class="badge">${x(record.variantBadge)}</span>
      </div>
      <dl>
        <dt>Bundle</dt><dd>${x(record.bundleId)}</dd>
        <dt>Version</dt><dd>${x(record.version)} <span class="dim">· build ${x(record.build)}</span></dd>
        <dt>Branch</dt><dd>${x(record.branch)}</dd>
        <dt>Commit</dt><dd>${x(commit)}</dd>
        <dt>Size</dt><dd>${x(record.ipaSizeLabel)}</dd>
        <dt>Built</dt><dd>${x(record.builtAt)}</dd>
      </dl>
      <a class="install-btn" href="${x(itmsServicesUrl(manifestUrl))}">Install ${x(record.versionTag)}</a>
    </div>`;
}

export interface IndexOptions {
  config: Config;
  ota: OtaConfig;
  token: string;
  generatedAt: string;
}

/** The rolling page, newest first. Pure: no bucket, no clock. */
export function renderIndexPage(records: BuildRecord[], options: IndexOptions): string {
  const sorted = sortRecords(records);
  const rows = sorted.length
    ? sorted
        .map((record) =>
          renderRow(
            record,
            publicUrl(
              options.ota,
              objectKey(options.ota, options.token, 'builds', record.buildId, 'manifest.plist'),
            ),
          ),
        )
        .join('\n')
    : '    <p class="empty">No builds uploaded yet.</p>';

  return fillTemplate(readTemplate('index-page.html'), {
    BRAND_TITLE: escapeHtml(brandTitle(options.config, options.ota)),
    ACCENT: brandAccent(options.ota),
    BUILD_COUNT: String(sorted.length),
    ROWS: rows,
    GENERATED_AT: escapeHtml(options.generatedAt),
  });
}

/** The per-build page: the spec sheet plus one install link. Pure. */
export function renderInstallPage(
  meta: BuildMetadata,
  options: { config: Config; ota: OtaConfig; manifestUrl: string; ipaSizeLabel: string },
): string {
  const x = escapeHtml;
  return fillTemplate(readTemplate('install-page.html'), {
    BRAND_TITLE: x(brandTitle(options.config, options.ota)),
    ACCENT: brandAccent(options.ota),
    APP_NAME: x(meta.appName),
    VARIANT_BADGE: x(meta.variantBadge),
    BUNDLE_ID: x(meta.bundleId),
    VERSION: x(meta.version),
    BUILD: x(meta.build),
    GIT_BRANCH: x(meta.branch),
    GIT_COMMIT: x(meta.dirty ? `${meta.commit} (dirty)` : meta.commit),
    CONFIGURATION: x(meta.configuration),
    ARCHS: x(meta.archs),
    IPA_SIZE: x(options.ipaSizeLabel),
    MIN_IOS: x(meta.minIos),
    SDK: x(meta.sdk),
    XCODE_BUILD: x(meta.xcodeBuild),
    SIGNED_BY: x(meta.signedBy),
    TEAM_ID: x(meta.teamId),
    BUILT_AT: x(meta.builtAt),
    INSTALL_HREF: x(itmsServicesUrl(options.manifestUrl)),
  });
}

const sortRecords = (records: BuildRecord[]): BuildRecord[] =>
  [...records].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));

/**
 * Fold a build into the registry: a rebuild of the same version replaces its
 * own row rather than appearing twice, then the oldest fall off the end.
 */
export function mergeRecords(
  existing: BuildRecord[],
  record: BuildRecord,
  maxBuilds: number,
): BuildRecord[] {
  const kept = existing.filter((row) => row.buildId !== record.buildId);
  return sortRecords([record, ...kept]).slice(0, maxBuilds);
}

async function readRegistry(store: ObjectStore, key: string): Promise<BuildRecord[]> {
  const text = await store.getText(key);
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as BuildRecord[]) : [];
  } catch {
    // A corrupt registry must not block a publish: the page is rebuilt from
    // what uploads now, and the bad object is overwritten by this run.
    return [];
  }
}

// ─── archive and export ──────────────────────────────────────────────────────

export interface ArchiveRequest {
  configuration: string;
  suffix: string;
  displayName: string;
  profiles: SigningProfiles;
  archivePath: string;
  buildNumber: string;
  gitSha?: string;
}

export function archiveArgs(
  boundary: Boundary,
  project: Project,
  request: ArchiveRequest,
): string[] {
  const { config } = project;
  return [
    'archive',
    ...project.xcodebuildTarget(),
    '-scheme',
    config.project.scheme,
    '-configuration',
    request.configuration,
    '-destination',
    'generic/platform=iOS',
    '-archivePath',
    request.archivePath,
    `CURRENT_PROJECT_VERSION=${request.buildNumber}`,
    ...(request.gitSha ? [`${config.variant.buildSettings.gitSha}=${request.gitSha}`] : []),
    ...variantSettings(request.suffix, request.displayName, config),
    ...signSettings(request.suffix, request.profiles, config),
    '-allowProvisioningUpdates',
    ...authArgs(boundary, config),
    '-quiet',
  ];
}

/**
 * `-allowProvisioningUpdates` on the export too, not only the archive: it lets
 * xcodebuild refresh a profile that went stale because a certificate was
 * rotated or a device was registered after it was minted. Without it the export
 * fails with "profile doesn't include signing certificate" and the only fix is
 * Xcode's Organizer by hand.
 */
export function exportArgs(
  boundary: Boundary,
  config: Config,
  options: { archivePath: string; exportDir: string; optionsPlist: string },
): string[] {
  return [
    '-exportArchive',
    '-archivePath',
    options.archivePath,
    '-exportOptionsPlist',
    options.optionsPlist,
    '-exportPath',
    options.exportDir,
    '-allowProvisioningUpdates',
    ...authArgs(boundary, config),
    '-quiet',
  ];
}

/** The bundle id → profile name map an export plist needs for a variant. */
export function exportProfileMap(
  config: Config,
  suffix: string,
  profiles: SigningProfiles,
): Record<string, string> {
  if (!suffix) return {};
  const map: Record<string, string> = {};
  for (const target of config.variant.targets) {
    const profile = profiles.byTarget[target.name];
    if (profile) map[targetBundleId(target, suffix, config)] = profile;
  }
  return map;
}

async function runArchive(
  boundary: Boundary,
  project: Project,
  request: ArchiveRequest,
): Promise<void> {
  await boundary.report.run('archive', 'archived', async (step) => {
    step.detail(buildNumberDetail(request.buildNumber));
    step.data({ buildNumber: request.buildNumber, configuration: request.configuration });
    const result = await boundary.exec.run('xcodebuild', archiveArgs(boundary, project, request), {
      cwd: project.root,
      allowFail: true,
    });
    if (!result.ok) {
      const tail = (result.stderr || result.stdout).trim().split('\n').slice(-20).join('\n');
      fail(`xcodebuild archive failed:\n${tail}`);
    }
    if (!boundary.fs.exists(request.archivePath)) {
      fail(
        `the archive reported success but produced nothing at ${request.archivePath}.\n` +
          '  Check that the scheme is shared and archives from Xcode.',
      );
    }
  });
}

/** Export the .ipa and return its path. The filename is the scheme's, not ours. */
async function runExport(
  boundary: Boundary,
  project: Project,
  options: { archivePath: string; exportDir: string; optionsPlist: string },
): Promise<string> {
  return boundary.report.run('export', 'exported .ipa', async () => {
    const result = await boundary.exec.run(
      'xcodebuild',
      exportArgs(boundary, project.config, options),
      { cwd: project.root, allowFail: true },
    );
    if (!result.ok) {
      const tail = (result.stderr || result.stdout).trim().split('\n').slice(-20).join('\n');
      fail(`xcodebuild -exportArchive failed:\n${tail}`);
    }
    const produced = boundary.fs
      .readdir(options.exportDir)
      .filter((name) => name.endsWith('.ipa'))
      .sort();
    const ipa = produced[0];
    if (!ipa) {
      fail(
        `the export produced no .ipa in ${options.exportDir}.\n` +
          '  Check that ota.exportMethod matches a certificate this machine holds.',
      );
    }
    return join(options.exportDir, ipa);
  });
}

// ─── the flow ────────────────────────────────────────────────────────────────

export interface OtaOptions {
  suffix: string;
  displayName: string;
  configuration?: string;
  gitSha?: string;
  /** Injected by tests. Production uses the AWS SDK client. */
  s3?: S3Factory;
}

export interface OtaResult {
  installUrl: string;
  indexUrl: string;
  manifestUrl: string;
  record: BuildRecord;
  builds: number;
}

/** The `ota` block, or a message saying exactly what to add. */
function requireOta(project: Project): OtaConfig {
  const ota = project.config.ota;
  if (!ota) {
    fail(
      'this project has no "ota" block in its config, so there is nowhere to publish to.\n' +
        '  Add ota.storage (bucket, region, publicBaseUrl) and re-run.',
    );
  }
  return ota;
}

export async function otaInstall(
  boundary: Boundary,
  project: Project,
  options: OtaOptions,
): Promise<OtaResult> {
  const { config } = project;
  const ota = requireOta(project);
  const configuration = options.configuration ?? config.configurations.archive;
  if (!config.configurations.available.includes(configuration)) {
    fail(
      `"${configuration}" is not one of this project's build configurations ` +
        `(${config.configurations.available.join(', ')})`,
    );
  }

  // Before the slow steps: an unset bucket credential must not cost an archive
  // and an export to discover.
  credentials(boundary, ota);

  const report = boundary.report;
  await requireToolchain(boundary, project, ['xcodebuild']);

  const bundleId = bundleIdFor(options.suffix, config);
  report.start({
    command: 'link',
    data: {
      destination: 'ota',
      bundleId,
      displayName: options.displayName,
      configuration,
      suffix: options.suffix,
    },
    title: [options.displayName, bundleId, configuration],
    rows: [
      {
        label: 'bucket',
        text: `${ota.storage.bucket} (${ota.storage.region}) → ${ota.storage.publicBaseUrl}`,
        event: 'bucket',
        data: {
          bucket: ota.storage.bucket,
          region: ota.storage.region,
          publicBaseUrl: ota.storage.publicBaseUrl,
        },
      },
      {
        label: 'signing',
        text: options.suffix
          ? `${ota.exportMethod} profiles for this variant, from Apple`
          : `${ota.exportMethod}, against the project's own signing`,
        event: 'signing',
        data: { decision: options.suffix ? 'provision' : 'project', method: ota.exportMethod },
      },
    ],
  });

  const work = join(scratchPath(boundary, options.suffix), 'ota');
  boundary.fs.rm(work, { recursive: true });
  boundary.fs.mkdirp(work);
  const archivePath = join(work, `${config.project.scheme}.xcarchive`);
  const exportDir = join(work, 'export');

  // Ad hoc profiles, not development ones: a development profile signs an app
  // that installs down a cable and refuses to install over the air.
  const profiles: SigningProfiles = options.suffix
    ? await report.run('provision', 'provisioned', async (step) => {
        const provisioned = await provisionVariant(boundary, project, {
          suffix: options.suffix,
          displayName: options.displayName,
          profileType: PROFILE_TYPES[ota.exportMethod],
        });
        step.data({ profiles: provisioned.map((profile) => profile.profileName) });
        step.detail(provisioned.map((profile) => profile.profileName).join(' + '));
        return {
          byTarget: Object.fromEntries(provisioned.map((p) => [p.target, p.profileName])),
        };
      })
    : { byTarget: {} };

  await generateProject(boundary, project);
  await runHook(boundary, project, 'preBuild');

  // The swap is restored the moment the archive returns. The export, the upload
  // and the preflight that follow do not need it, and a hang in any of them
  // would otherwise leave the working tree dirty.
  const request: ArchiveRequest = {
    configuration,
    suffix: options.suffix,
    displayName: options.displayName,
    profiles,
    archivePath,
    buildNumber: buildNumber(boundary),
    ...(options.gitSha ? { gitSha: options.gitSha } : {}),
  };
  await withEntitlementSwap(
    boundary,
    project,
    { suffix: options.suffix, backupPath: join(work, 'project.pbxproj.orig') },
    () => runArchive(boundary, project, request),
  );

  const optionsPlist = join(work, 'exportOptions.plist');
  boundary.fs.write(
    optionsPlist,
    renderExportOptionsPlist({
      teamId: config.project.teamId,
      method: ota.exportMethod,
      provisioningProfiles: exportProfileMap(config, options.suffix, profiles),
    }),
  );
  const ipa = await runExport(boundary, project, { archivePath, exportDir, optionsPlist });

  const meta = await archiveMetadata(boundary, project, {
    archivePath,
    suffix: options.suffix,
    configuration,
  });
  if (meta.dirty) report.warn('the working tree is dirty — this .ipa matches no commit');

  await runHook(boundary, project, 'postBuild');

  const published = await publish(boundary, project, { ota, ipa, meta, s3: options.s3 });
  report.done(true, { builds: published.builds, bundleId });
  return published;
}

/**
 * Upload the .ipa, its manifest and its page; fold the build into the registry;
 * rebuild the index; and only then confirm the manifest is actually reachable.
 */
export async function publish(
  boundary: Boundary,
  project: Project,
  options: { ota: OtaConfig; ipa: string; meta: BuildMetadata; s3?: S3Factory },
): Promise<OtaResult> {
  const { config } = project;
  const { ota, meta } = options;
  const token = projectToken(boundary, config.project.baseBundleId);
  const store = createStore(boundary, ota, options.s3);

  const buildId = buildIdFor(meta);
  const key = (...segments: string[]): string => objectKey(ota, token, ...segments);
  const buildKey = (...segments: string[]): string => key('builds', buildId, ...segments);

  const ipaBytes = boundary.fs.size(options.ipa);
  const ipaSizeLabel = megabytes(ipaBytes);

  const manifestUrl = publicUrl(ota, buildKey('manifest.plist'));
  const record: BuildRecord = {
    buildId,
    appName: meta.appName,
    bundleId: meta.bundleId,
    version: meta.version,
    build: meta.build,
    versionTag: meta.versionTag,
    variantBadge: meta.variantBadge,
    branch: meta.branch,
    commit: meta.commit,
    dirty: meta.dirty,
    ipaSizeLabel,
    ipaSizeBytes: ipaBytes,
    builtAt: meta.builtAt,
    uploadedAt: new Date(boundary.now() * 1000).toISOString(),
  };

  const merged = await boundary.report.run('upload', 'uploaded', async (step) => {
    step.detail(`${ipaSizeLabel} → ${ota.storage.bucket}/${buildKey(IPA_NAME)}`);
    step.data({ bytes: ipaBytes, key: buildKey(IPA_NAME), bucket: ota.storage.bucket });

    // One icon at the prefix root, referenced by every manifest, so the tile
    // that appears while installing is the app's icon and not a grey
    // placeholder.
    const iconPath = config.project.appIcon ? project.path(config.project.appIcon) : '';
    const iconUrl =
      iconPath && boundary.fs.exists(iconPath) ? publicUrl(ota, key('icon.png')) : undefined;
    if (iconUrl) {
      await store.put(key('icon.png'), boundary.fs.readBytes(iconPath), 'image/png');
    }

    await store.put(
      buildKey(IPA_NAME),
      boundary.fs.readBytes(options.ipa),
      'application/octet-stream',
    );
    await store.put(
      buildKey('manifest.plist'),
      renderManifestPlist({
        bundleId: meta.bundleId,
        bundleVersion: meta.version,
        title: meta.appName,
        ipaUrl: publicUrl(ota, buildKey(IPA_NAME)),
        ...(iconUrl ? { displayImageUrl: iconUrl, fullSizeImageUrl: iconUrl } : {}),
      }),
      'text/xml',
    );
    await store.put(
      buildKey('index.html'),
      renderInstallPage(meta, { config, ota, manifestUrl, ipaSizeLabel }),
      'text/html; charset=utf-8',
    );

    const rows = mergeRecords(await readRegistry(store, key(REGISTRY_NAME)), record, ota.maxBuilds);
    await store.put(key(REGISTRY_NAME), JSON.stringify(rows, null, 2), 'application/json');
    await store.put(
      key('index.html'),
      renderIndexPage(rows, { config, ota, token, generatedAt: utcStamp(boundary.now()) }),
      'text/html; charset=utf-8',
    );
    return rows;
  });

  // Last, and never earlier: a printed URL that 403s costs a build cycle to
  // diagnose from the phone, where the only symptom is "Cannot connect".
  await boundary.report.run('verify', 'verified', () =>
    verifyReachable(boundary, ota, manifestUrl),
  );

  const installUrl = publicUrl(ota, buildKey('index.html'));
  const indexUrl = publicUrl(ota, key('index.html'));
  boundary.report.emit('link', { installUrl, indexUrl, manifestUrl, builds: merged.length });
  boundary.report.note('');
  boundary.report.note(`install  ${installUrl}`);
  boundary.report.note(`builds   ${indexUrl}`);
  return { installUrl, indexUrl, manifestUrl, record, builds: merged.length };
}

/**
 * Rebuild the index page from the bucket alone — no build, no archive. For when
 * the page was clobbered, the registry was hand-edited, or the branding
 * changed and every page should say the new thing.
 */
export async function reindex(
  boundary: Boundary,
  project: Project,
  options: { s3?: S3Factory } = {},
): Promise<{ indexUrl: string; builds: number }> {
  const ota = requireOta(project);
  const token = projectToken(boundary, project.config.project.baseBundleId);
  const store = createStore(boundary, ota, options.s3);

  const records = await readRegistry(store, objectKey(ota, token, REGISTRY_NAME));
  const page = renderIndexPage(records, {
    config: project.config,
    ota,
    token,
    generatedAt: utcStamp(boundary.now()),
  });
  await store.put(objectKey(ota, token, 'index.html'), page, 'text/html; charset=utf-8');

  const indexUrl = publicUrl(ota, objectKey(ota, token, 'index.html'));
  boundary.report.emit('reindex', { indexUrl, builds: records.length });
  return { indexUrl, builds: records.length };
}
