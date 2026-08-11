/**
 * `jetbridge init` — the only thing that should ever write a config file.
 *
 * The order is fixed, and each step exists because of a failure it stops:
 * detect (so the wizard asks as little as possible) → ask what is left → verify
 * what can be verified cheaply (credentials resolve, the bucket round-trips) →
 * dry run (show the file and the commands, confirm) → write → read the file
 * back through `parseConfig`, so what the wizard produced is provably a file
 * the rest of the tool accepts.
 *
 * There is always a flag-driven route through: `--yes` behind a pipe answers
 * nothing and fails loudly, naming the flag that supplies each value it could
 * not infer. A prompt in CI hangs forever, which is worse than any error.
 */
import { join, resolve } from 'node:path';
import { localCredentials, missingCredentialsMessage } from './asc.js';
import type { Boundary } from './boundary.js';
import {
  CONFIG_FILENAMES,
  CONFIG_VERSION,
  formatConfigErrors,
  parseConfig,
  type Config,
} from './config.js';
import { detectProject, type Detection, type Suggestion } from './detect.js';
import { fail, projectFrom, type Project } from './project.js';
import type { Prompter } from './prompts.js';

/** Editors autocomplete against the published schema, not against this file. */
export const SCHEMA_URL = 'https://unpkg.com/jetbridge/schema/v1.json';

const DEFAULT_CONFIGURATIONS = ['Debug', 'Release'];

/* -------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* -------------------------------------------------------------------------- */

export interface TargetInput {
  name: string;
  bundleIdSuffix?: string;
  entitlements?: string;
}

export interface ConfigInput {
  iosDir: string;
  xcodeproj?: string;
  xcworkspace?: string;
  scheme: string;
  teamId: string;
  baseBundleId: string;
  projectYml?: string;
  xcodegen?: boolean;
  configurations: { available: string[]; wired: string; sim: string; archive: string };
  displayName: string;
  targets: TargetInput[];
  credentials: { ascKeyId: string; ascIssuerId: string };
  ota?: { bucket: string; region: string; endpoint?: string; publicBaseUrl: string };
}

/**
 * The config as an ordinary object, in schema order. Key order is the literal's
 * order, so the written file reads top-down the way the schema is documented
 * rather than the way the wizard happened to ask.
 */
export function assembleConfig(input: ConfigInput): Record<string, unknown> {
  return {
    $schema: SCHEMA_URL,
    configVersion: CONFIG_VERSION,
    project: {
      iosDir: input.iosDir,
      ...(input.xcodeproj ? { xcodeproj: input.xcodeproj } : {}),
      ...(input.xcworkspace ? { xcworkspace: input.xcworkspace } : {}),
      scheme: input.scheme,
      teamId: input.teamId,
      baseBundleId: input.baseBundleId,
      ...(input.projectYml ? { projectYml: input.projectYml } : {}),
      ...(input.xcodegen ? { xcodegen: true } : {}),
    },
    configurations: {
      available: input.configurations.available,
      wired: input.configurations.wired,
      sim: input.configurations.sim,
      archive: input.configurations.archive,
    },
    variant: {
      displayName: input.displayName,
      targets: input.targets.map((target) => ({
        name: target.name,
        ...(target.bundleIdSuffix ? { bundleIdSuffix: target.bundleIdSuffix } : {}),
        ...(target.entitlements ? { entitlements: target.entitlements } : {}),
      })),
    },
    credentials: {
      ascKeyId: input.credentials.ascKeyId,
      ascIssuerId: input.credentials.ascIssuerId,
    },
    ...(input.ota
      ? {
          ota: {
            storage: {
              bucket: input.ota.bucket,
              region: input.ota.region,
              ...(input.ota.endpoint ? { endpoint: input.ota.endpoint } : {}),
              publicBaseUrl: input.ota.publicBaseUrl,
            },
          },
        }
      : {}),
  };
}

export const serializeConfig = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/* -------------------------------------------------------------------------- */
/* Dry run                                                                    */
/* -------------------------------------------------------------------------- */

export interface CommandPreview {
  mode: 'wired' | 'sim' | 'archive';
  command: string;
}

const quote = (value: string): string => (/[\s]/.test(value) ? `'${value}'` : value);

/**
 * What each mode will run, as the config determines it. Signing flags and the
 * build number are decided at run time and left out — the point of the preview
 * is the scheme, the configuration and the destination, which are exactly what
 * the answers just chose.
 */
export function commandPreviews(project: Project): CommandPreview[] {
  const { config } = project;
  const target = project.xcodebuildTarget().map(quote).join(' ');
  const line = (verb: string, configuration: string, destination: string): string =>
    [
      'xcodebuild',
      verb,
      target,
      '-scheme',
      quote(config.project.scheme),
      '-configuration',
      quote(configuration),
      '-destination',
      quote(destination),
    ].join(' ');
  return [
    { mode: 'wired', command: line('build', config.configurations.wired, 'generic/platform=iOS') },
    { mode: 'sim', command: line('build', config.configurations.sim, 'platform=iOS Simulator') },
    {
      mode: 'archive',
      command: line('archive', config.configurations.archive, 'generic/platform=iOS'),
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Repair                                                                     */
/* -------------------------------------------------------------------------- */

export interface Drift {
  /** Dotted config path, e.g. `project.scheme`. */
  path: string;
  current: unknown;
  detected: unknown;
  /** Why the current value is suspect, when it is more than "they differ". */
  note?: string;
  source: string;
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What the project says that the existing config does not. */
export function detectDrift(config: Config, detection: Detection): Drift[] {
  const drift: Drift[] = [];
  const add = (
    path: string,
    current: unknown,
    detected: Suggestion<unknown> | undefined,
    note?: string,
  ): void => {
    if (!detected || sameValue(current, detected.value)) return;
    drift.push({
      path,
      current,
      detected: detected.value,
      source: detected.source,
      ...(note ? { note } : {}),
    });
  };

  add('project.iosDir', config.project.iosDir, detection.iosDir);
  add('project.xcodeproj', config.project.xcodeproj, detection.xcodeproj);
  add('project.xcworkspace', config.project.xcworkspace, detection.xcworkspace);
  add('project.teamId', config.project.teamId, detection.teamId);
  add('project.baseBundleId', config.project.baseBundleId, detection.baseBundleId);

  // A scheme is only drift when the project no longer has one by that name.
  // Renaming a scheme is the failure this catches; preferring a different one
  // is the developer's business.
  if (detection.schemes.length > 0 && !detection.schemes.includes(config.project.scheme)) {
    const replacement = detection.scheme?.value ?? detection.schemes[0]!;
    drift.push({
      path: 'project.scheme',
      current: config.project.scheme,
      detected: replacement,
      note: `the project has no scheme named "${config.project.scheme}" any more`,
      source: detection.scheme?.source ?? detection.iosDir.source,
    });
  }

  const available = detection.configurations;
  if (available) {
    add('configurations.available', config.configurations.available, available);
    for (const field of ['wired', 'sim', 'archive'] as const) {
      const current = config.configurations[field];
      if (available.value.includes(current)) continue;
      const fallback = field === 'archive' ? 'Release' : 'Debug';
      drift.push({
        path: `configurations.${field}`,
        current,
        detected: available.value.includes(fallback) ? fallback : available.value[0]!,
        note: `the project has no "${current}" build configuration any more`,
        source: available.source,
      });
    }
  }
  return drift;
}

/** Set one dotted path on the raw JSON, creating nothing that is not already there. */
function setPath(raw: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let node = raw;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (typeof next !== 'object' || next === null) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts.at(-1)!] = value;
}

/* -------------------------------------------------------------------------- */
/* The wizard                                                                 */
/* -------------------------------------------------------------------------- */

export interface OtaStorageInput {
  bucket: string;
  region: string;
  endpoint?: string;
  publicBaseUrl: string;
  prefix: string;
}

export interface OtaRoundTripResult {
  ok: boolean;
  /** One line, shown either way: what was proved, or what broke. */
  detail: string;
}

/**
 * Upload a small object, fetch it back over the public base URL, delete it.
 * Injected: a wrong bucket policy is worth ten seconds here instead of a
 * fifteen-minute archive that cannot be installed.
 */
export type OtaRoundTrip = (
  boundary: Boundary,
  storage: OtaStorageInput,
) => Promise<OtaRoundTripResult>;

export interface InitOptions {
  /** Where the config file goes. Defaults to the working directory. */
  cwd?: string;
  /** Accept every detected default and never prompt. */
  yes?: boolean;
  iosDir?: string;
  xcodeproj?: string;
  xcworkspace?: string;
  scheme?: string;
  teamId?: string;
  bundleId?: string;
  displayName?: string;
  configurations?: string[];
  wired?: string;
  sim?: string;
  archive?: string;
  ascKeyIdEnv?: string;
  ascIssuerIdEnv?: string;
  ota?: boolean;
  otaBucket?: string;
  otaRegion?: string;
  otaEndpoint?: string;
  otaPublicBaseUrl?: string;
}

export interface InitDeps {
  prompts: Prompter;
  otaRoundTrip?: OtaRoundTrip;
}

export interface InitResult {
  status: 'written' | 'declined' | 'unchanged';
  configPath: string;
  config?: Config;
  /** What a repair pass found, empty on a first run. */
  drift: Drift[];
}

const teamIdProblem = (value: string): string | undefined =>
  /^[A-Z0-9]{10}$/.test(value) ? undefined : 'an Apple team id is 10 uppercase alphanumerics';

const bundleIdProblem = (value: string): string | undefined =>
  /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(value)
    ? undefined
    : 'a reverse-DNS bundle id, e.g. io.acme.app.dev';

const httpsProblem = (value: string): string | undefined => {
  if (!value.startsWith('https://')) return 'must be https:// — iOS refuses to install over http';
  try {
    new URL(value);
    return undefined;
  } catch {
    return 'not a URL';
  }
};

const envNameProblem = (value: string): string | undefined =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? undefined : 'must be a plain identifier';

export async function runInit(
  boundary: Boundary,
  options: InitOptions,
  deps: InitDeps,
): Promise<InitResult> {
  const root = resolve(options.cwd ?? boundary.cwd());
  const configPath = join(root, CONFIG_FILENAMES[0]);
  // The exact path, never the upward walk: a config in a parent directory is
  // somebody else's project, not this one to repair.
  const existing = boundary.fs.exists(configPath);

  const detection = detectProject(boundary, {
    root,
    ...(options.iosDir ? { iosDir: options.iosDir } : {}),
  });
  for (const warning of detection.warnings) boundary.log.warn(`! ${warning}`);

  return existing
    ? repair(boundary, options, deps, configPath, detection)
    : create(boundary, options, deps, configPath, detection);
}

async function create(
  boundary: Boundary,
  options: InitOptions,
  deps: InitDeps,
  configPath: string,
  detection: Detection,
): Promise<InitResult> {
  const { prompts } = deps;
  // No terminal means no questions, so the flags have to carry everything.
  const auto = options.yes === true || !boundary.interactive;
  const missing: Array<{ field: string; flag: string }> = [];

  const ask = async (spec: {
    field: string;
    flag: string;
    message: string;
    given?: string;
    detected?: Suggestion<string>;
    validate?: (value: string) => string | undefined;
  }): Promise<string> => {
    if (spec.given !== undefined) {
      const problem = spec.validate?.(spec.given);
      if (problem) fail(`${spec.flag} ${spec.given}: ${problem}`);
      return spec.given;
    }
    if (auto) {
      if (spec.detected) return spec.detected.value;
      missing.push({ field: spec.field, flag: spec.flag });
      return '';
    }
    return prompts.text({
      name: spec.field,
      message: spec.message,
      ...(spec.detected
        ? { initial: spec.detected.value, hint: `from ${spec.detected.source}` }
        : {}),
      ...(spec.validate ? { validate: spec.validate } : {}),
    });
  };

  const iosDir = await ask({
    field: 'project.iosDir',
    flag: '--ios-dir',
    message: 'Directory holding the Xcode project',
    given: options.iosDir,
    detected: detection.iosDir,
  });
  const xcodeproj = options.xcodeproj ?? detection.xcodeproj?.value;
  const xcworkspace = options.xcworkspace ?? detection.xcworkspace?.value;
  if (!xcodeproj && !xcworkspace) {
    missing.push({ field: 'project.xcodeproj', flag: '--xcodeproj' });
  }

  const scheme = await ask({
    field: 'project.scheme',
    flag: '--scheme',
    message: 'Scheme to build',
    given: options.scheme,
    detected: detection.scheme,
  });
  const teamId = await ask({
    field: 'project.teamId',
    flag: '--team-id',
    message: 'Apple team id',
    given: options.teamId,
    detected: detection.teamId,
    validate: teamIdProblem,
  });
  const baseBundleId = await ask({
    field: 'project.baseBundleId',
    flag: '--bundle-id',
    message: 'Bundle id a variant build extends',
    given: options.bundleId,
    detected: detection.baseBundleId,
    validate: bundleIdProblem,
  });
  const displayName = await ask({
    field: 'variant.displayName',
    flag: '--display-name',
    message: 'Home-screen label for a plain build',
    given: options.displayName,
    detected: detection.displayName,
  });

  const available = options.configurations ?? detection.configurations?.value;
  if (!available) {
    boundary.log.warn(
      `! no build configurations were read out of the project, so ${DEFAULT_CONFIGURATIONS.join(
        ' and ',
      )} are assumed.`,
    );
  }
  const configurations = available ?? DEFAULT_CONFIGURATIONS;

  const pickConfiguration = async (
    field: 'wired' | 'sim' | 'archive',
    flag: string,
    message: string,
    given: string | undefined,
    preferred: string,
  ): Promise<string> => {
    if (given !== undefined) {
      if (!configurations.includes(given)) {
        fail(`${flag} ${given}: the project has no "${given}" build configuration`);
      }
      return given;
    }
    // Naming a configuration the project does not have fails deep inside
    // xcodebuild, so a missing default is asked for, never assumed.
    if (configurations.includes(preferred)) return preferred;
    if (auto) {
      missing.push({ field: `configurations.${field}`, flag });
      return '';
    }
    return prompts.select({
      name: `configurations.${field}`,
      message,
      options: configurations.map((value) => ({ value })),
    });
  };

  const wired = await pickConfiguration(
    'wired',
    '--configuration-wired',
    'Build configuration for a cabled install',
    options.wired,
    'Debug',
  );
  const sim = await pickConfiguration(
    'sim',
    '--configuration-sim',
    'Build configuration for a simulator install',
    options.sim,
    'Debug',
  );
  const archive = await pickConfiguration(
    'archive',
    '--configuration-archive',
    'Build configuration for an archive',
    options.archive,
    'Release',
  );

  const ascKeyId = await ask({
    field: 'credentials.ascKeyId',
    flag: '--asc-key-id-env',
    message: 'Environment variable holding the App Store Connect key id',
    given: options.ascKeyIdEnv,
    detected: { value: 'ASC_API_KEY_ID', source: 'the jetbridge default' },
    validate: envNameProblem,
  });
  const ascIssuerId = await ask({
    field: 'credentials.ascIssuerId',
    flag: '--asc-issuer-id-env',
    message: 'Environment variable holding the App Store Connect issuer id',
    given: options.ascIssuerIdEnv,
    detected: { value: 'ASC_API_ISSUER_ID', source: 'the jetbridge default' },
    validate: envNameProblem,
  });

  let xcodegen = false;
  if (detection.projectYml) {
    xcodegen = auto
      ? true
      : await prompts.confirm({
          name: 'project.xcodegen',
          message: `Run xcodegen from ${detection.projectYml.value} before each build?`,
          initial: true,
        });
  }

  const wantsOta =
    options.ota ??
    (auto
      ? false
      : await prompts.confirm({
          name: 'ota.enabled',
          message: 'Deliver builds over the air to your own bucket?',
          initial: false,
        }));

  let ota: ConfigInput['ota'];
  if (wantsOta) {
    const bucket = await ask({
      field: 'ota.storage.bucket',
      flag: '--ota-bucket',
      message: 'Bucket builds are uploaded to',
      given: options.otaBucket,
    });
    const region = await ask({
      field: 'ota.storage.region',
      flag: '--ota-region',
      message: 'Bucket region',
      given: options.otaRegion,
      detected: { value: 'us-east-1', source: 'the jetbridge default' },
    });
    const endpoint =
      options.otaEndpoint ??
      (auto
        ? ''
        : await prompts.text({
            name: 'ota.storage.endpoint',
            message: 'S3-compatible endpoint (blank for AWS)',
          }));
    const publicBaseUrl = await ask({
      field: 'ota.storage.publicBaseUrl',
      flag: '--ota-public-base-url',
      message: 'Public https:// base URL the uploads are readable from',
      given: options.otaPublicBaseUrl,
      validate: httpsProblem,
    });
    ota = { bucket, region, publicBaseUrl, ...(endpoint ? { endpoint } : {}) };
  }

  if (missing.length > 0) {
    fail(
      'these could not be worked out from the project, and there is nobody to ask:\n' +
        missing.map((entry) => `  ${entry.field} — pass ${entry.flag}`).join('\n'),
    );
  }

  if (ota) {
    const kept = await verifyOta(boundary, deps, ota, auto);
    if (!kept) return { status: 'declined', configPath, drift: [] };
  }

  const raw = assembleConfig({
    iosDir,
    ...(xcodeproj ? { xcodeproj } : {}),
    ...(xcworkspace ? { xcworkspace } : {}),
    scheme,
    teamId,
    baseBundleId,
    ...(detection.projectYml ? { projectYml: detection.projectYml.value } : {}),
    xcodegen,
    configurations: { available: configurations, wired, sim, archive },
    displayName,
    targets: detection.targets.map((target) => ({
      name: target.name,
      ...(target.bundleIdSuffix ? { bundleIdSuffix: target.bundleIdSuffix } : {}),
      ...(target.entitlements ? { entitlements: target.entitlements.value } : {}),
    })),
    credentials: { ascKeyId, ascIssuerId },
    ...(ota ? { ota } : {}),
  });

  return finish(boundary, deps, configPath, raw, auto, options, []);
}

const KEEP_OTA = { name: 'ota.continue', message: 'Keep these OTA settings anyway?' };

/** The failed-check path: warn with the reason, then offer to go on. */
async function verifyOta(
  boundary: Boundary,
  deps: InitDeps,
  ota: NonNullable<ConfigInput['ota']>,
  auto: boolean,
): Promise<boolean> {
  if (!deps.otaRoundTrip) {
    // A wiring gap, not a wrong answer: there is nothing to reject.
    boundary.log.warn(
      '! the OTA settings were not verified — the bucket round trip was skipped because no ' +
        'checker was wired in.',
    );
    return auto ? true : deps.prompts.confirm({ ...KEEP_OTA, initial: false });
  }

  const result = await deps.otaRoundTrip(boundary, { ...ota, prefix: 'builds' });
  if (result.ok) {
    boundary.log.info(`✓ ${result.detail}`);
    return true;
  }
  boundary.log.warn(`! the OTA settings could not be verified: ${result.detail}`);
  // Under `--yes` there is nobody to overrule the check, and a config that
  // cannot deliver is worse than a non-zero exit. Leave `--ota` off to skip it.
  if (auto) {
    fail(
      `the OTA round trip failed: ${result.detail}.\n` +
        '  Fix the bucket, or re-run without --ota to leave over-the-air delivery out.',
    );
  }
  return deps.prompts.confirm({ ...KEEP_OTA, initial: false });
}

/**
 * The config stores names, so the values behind them are checked here and
 * nowhere else — and a name that does not resolve is a warning, never a
 * failure: the machine that runs `init` is not always the machine that signs.
 */
function warnAboutCredentials(boundary: Boundary, config: Config): void {
  const unresolved = (
    [
      ['credentials.ascKeyId', config.credentials.ascKeyId],
      ['credentials.ascIssuerId', config.credentials.ascIssuerId],
    ] as const
  ).filter(([, name]) => boundary.env(name) === undefined);

  for (const [field, name] of unresolved) {
    boundary.log.warn(
      `! ${name} is not set in this environment — ${field} names it, and anything that talks ` +
        'to App Store Connect will fail until it resolves.',
    );
  }
  // The key file is found by search, so `credentials.ascKeyPath` being unset is
  // normal — the key being nowhere on the search path is not.
  if (unresolved.length === 0 && localCredentials(boundary, config) === null) {
    boundary.log.warn(`! ${missingCredentialsMessage(config)}`);
  }
}

/** Dry run, confirm, write, and read the file back through the validator. */
async function finish(
  boundary: Boundary,
  deps: InitDeps,
  configPath: string,
  raw: Record<string, unknown>,
  auto: boolean,
  options: InitOptions,
  drift: Drift[],
): Promise<InitResult> {
  const checked = parseConfig(raw);
  if (!checked.ok) {
    fail(`the answers do not make a valid config:\n${formatConfigErrors(checked.errors)}`);
  }

  warnAboutCredentials(boundary, checked.config);

  const contents = serializeConfig(raw);
  deps.prompts.note(contents.trimEnd(), configPath);
  for (const preview of commandPreviews(projectFrom(configPath, checked.config))) {
    boundary.log.info(`  ${preview.mode.padEnd(7)} ${preview.command}`);
  }

  if (auto) {
    // Nothing has been written yet, and there is no way to ask. `--yes` is the
    // consent; without it, a pipe would write a file nobody looked at.
    if (options.yes !== true) {
      fail(`nothing was written — re-run with --yes to accept these values without a terminal.`);
    }
  } else {
    const write = await deps.prompts.confirm({
      name: 'write',
      message: `Write ${configPath}?`,
      initial: true,
    });
    if (!write) {
      boundary.log.info('nothing was written.');
      return { status: 'declined', configPath, drift };
    }
  }

  boundary.fs.write(configPath, contents);

  // Read it back off disk rather than trusting the object in hand: the file is
  // what every later command loads.
  let written: unknown;
  try {
    written = JSON.parse(boundary.fs.read(configPath));
  } catch (e) {
    return fail(`${configPath} was written but is not valid JSON — ${(e as Error).message}`);
  }
  const reread = parseConfig(written);
  if (!reread.ok) {
    fail(
      `${configPath} was written but jetbridge refuses it:\n${formatConfigErrors(reread.errors)}`,
    );
  }
  boundary.log.info(`wrote ${configPath}`);
  return { status: 'written', configPath, config: reread.config, drift };
}

/**
 * A second `init` is a repair pass, not a fresh start: only the fields the
 * project disagrees with are offered, and everything else in the file — hand
 * written sections included — is left exactly as it is.
 */
async function repair(
  boundary: Boundary,
  options: InitOptions,
  deps: InitDeps,
  configPath: string,
  detection: Detection,
): Promise<InitResult> {
  const auto = options.yes === true || !boundary.interactive;
  let raw: unknown;
  try {
    raw = JSON.parse(boundary.fs.read(configPath));
  } catch (e) {
    return fail(`${configPath} is not valid JSON — ${(e as Error).message}`);
  }
  const parsed = parseConfig(raw);
  if (!parsed.ok) {
    fail(
      `${configPath} already exists but jetbridge refuses it, so there is nothing to compare ` +
        `against:\n${formatConfigErrors(parsed.errors)}\n  Fix or delete it, then re-run.`,
    );
  }

  const drift = detectDrift(parsed.config, detection);
  if (drift.length === 0) {
    boundary.log.info(`${configPath} still matches the project — nothing to change.`);
    return { status: 'unchanged', configPath, drift };
  }

  boundary.log.info(`${configPath} and the project disagree:`);
  for (const entry of drift) {
    const reason = entry.note ? ` — ${entry.note}` : '';
    boundary.log.info(
      `  ${entry.path}: ${JSON.stringify(entry.current)} → ${JSON.stringify(entry.detected)}` +
        `${reason} (${entry.source})`,
    );
  }

  const merged = raw as Record<string, unknown>;
  const accepted: Drift[] = [];
  for (const entry of drift) {
    const take =
      auto ||
      (await deps.prompts.confirm({
        name: `update:${entry.path}`,
        message: `Update ${entry.path} to ${JSON.stringify(entry.detected)}?`,
        initial: true,
      }));
    if (!take) continue;
    setPath(merged, entry.path, entry.detected);
    accepted.push(entry);
  }

  if (accepted.length === 0) {
    boundary.log.info('nothing was changed.');
    return { status: 'unchanged', configPath, drift };
  }
  return finish(boundary, deps, configPath, merged, auto, options, accepted);
}
