/**
 * The cabled install: build, then push the `.app` straight to every reachable
 * paired device with `xcrun devicectl`. No archive, no export, no upload — the
 * fast inner loop when the phone is on the desk.
 */
import { join } from 'node:path';
import { localCredentials } from './asc.js';
import type { Boundary } from './boundary.js';
import {
  build,
  buildNumber,
  generateProject,
  productPath,
  requireToolchain,
  runHook,
} from './build.js';
import { pairedDevices, resolveTargets, type InstallTarget } from './devices.js';
import { withEntitlementSwap } from './entitlements.js';
import { fail, type Project } from './project.js';
import { provisionVariant } from './provision.js';
import { cachedSigning, type SigningProfiles } from './signing.js';
import { bundleIdFor } from './variant.js';

export interface WiredOptions {
  suffix: string;
  displayName: string;
  /** Install to one device: identifier, name, UDID or serial. */
  device?: string;
  configuration?: string;
  /** Wipe the cached DerivedData first, for a genuinely corrupt build. */
  clean?: boolean;
  /** Bypass the on-disk profile cache — reach for this after a certificate rotation. */
  reprovision?: boolean;
}

/**
 * DerivedData that persists per variant, so a repeat install is incremental.
 *
 * This is the inner loop's biggest lever: wiping it turns every install into a
 * clean build of every dependency. It lives under the user cache directory so
 * the OS can reclaim it under disk pressure and the next build repopulates it.
 * Keyed by variant only — xcodebuild namespaces the configuration internally.
 */
export function derivedDataPath(boundary: Boundary, suffix: string): string {
  return join(boundary.homedir(), 'Library', 'Caches', 'jetbridge', suffix || 'default');
}

export function scratchPath(boundary: Boundary, suffix: string): string {
  return join(
    boundary.homedir(),
    'Library',
    'Caches',
    'jetbridge',
    '.scratch',
    suffix || 'default',
  );
}

/**
 * Profiles for the build: the on-disk cache when it already covers exactly
 * these devices, otherwise fresh provisioning.
 */
async function resolveSigning(
  boundary: Boundary,
  project: Project,
  options: WiredOptions,
  targets: InstallTarget[],
): Promise<SigningProfiles> {
  if (!options.suffix) return { byTarget: {} };

  const deviceUdids = targets.map((target) => target.udid);
  if (!options.reprovision) {
    const cached = cachedSigning(boundary, project.config, {
      suffix: options.suffix,
      deviceUdids,
      now: boundary.now(),
    });
    if (cached) {
      boundary.log.info(
        'signing: cached profiles already cover these devices — skipping provisioning',
      );
      return cached;
    }
  }

  const provisioned = await provisionVariant(boundary, project, {
    suffix: options.suffix,
    displayName: options.displayName,
  });
  return {
    byTarget: Object.fromEntries(provisioned.map((p) => [p.target, p.profileName])),
  };
}

export async function wiredInstall(
  boundary: Boundary,
  project: Project,
  options: WiredOptions,
): Promise<void> {
  const { config } = project;
  const configuration = options.configuration ?? config.configurations.wired;
  if (!config.configurations.available.includes(configuration)) {
    fail(
      `"${configuration}" is not one of this project's build configurations ` +
        `(${config.configurations.available.join(', ')})`,
    );
  }
  if (options.suffix && !localCredentials(boundary, config)) {
    fail(
      'a variant build has to register a new bundle id, which needs App Store Connect ' +
        'credentials.\n  Drop the variant to build the plain bundle id instead.',
    );
  }

  await requireToolchain(boundary, project, ['xcodebuild', 'xcrun']);
  await generateProject(boundary, project);
  await runHook(boundary, project, 'preBuild');

  const derivedData = derivedDataPath(boundary, options.suffix);
  if (options.clean) {
    boundary.log.info('--clean: wiping DerivedData for a build from scratch');
    boundary.fs.rm(derivedData, { recursive: true });
  }
  boundary.fs.mkdirp(derivedData);

  const scratch = scratchPath(boundary, options.suffix);
  boundary.fs.rm(scratch, { recursive: true });
  boundary.fs.mkdirp(scratch);

  // Resolve devices BEFORE the slow build, so an unplugged phone fails in a
  // second instead of after a minute of compiling — and so the signing cache
  // can check that its profiles cover exactly these devices.
  const targets = resolveTargets(
    boundary,
    await pairedDevices(boundary, config, scratch),
    options.device ?? '',
  );
  const profiles = await resolveSigning(boundary, project, options, targets);

  // The swap is restored the moment the build returns — before the install runs
  // — so a failed or hung install can never leave the working tree dirty.
  const appPath = await withEntitlementSwap(
    boundary,
    project,
    { suffix: options.suffix, backupPath: join(scratch, 'project.pbxproj.orig') },
    async () => {
      const request = {
        configuration,
        suffix: options.suffix,
        displayName: options.displayName,
        profiles,
        derivedDataPath: derivedData,
        destination: 'generic/platform=iOS',
        buildNumber: buildNumber(boundary),
      };
      await build(boundary, project, request);
      const built = productPath(request, config, 'iphoneos');
      if (!boundary.fs.exists(built)) {
        fail(`the build reported success but produced no app at ${built}`);
      }
      return built;
    },
  );
  boundary.log.info(`built → ${appPath}`);

  await runHook(boundary, project, 'postBuild');

  const bundleId = bundleIdFor(options.suffix, config);
  const failures: string[] = [];
  for (const target of targets) {
    boundary.log.step(`installing to ${target.name} (${target.id})`);
    const result = await boundary.exec.run(
      'xcrun',
      ['devicectl', 'device', 'install', 'app', '--device', target.id, appPath],
      { allowFail: true },
    );
    if (result.ok) {
      boundary.log.info(`installed ${bundleId} ("${options.displayName}") → ${target.name}`);
    } else {
      boundary.log.warn(`install failed on ${target.name} (${target.id})`);
      failures.push(target.name);
    }
  }
  if (failures.length > 0) {
    fail(`${failures.length} of ${targets.length} installs failed: ${failures.join(', ')}`);
  }
  boundary.log.info(`done — ${targets.length} device(s), ${bundleId} ("${options.displayName}")`);
}
