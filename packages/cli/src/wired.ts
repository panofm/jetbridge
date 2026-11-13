/**
 * The cabled install: build, then push the `.app` straight to every reachable
 * paired device with `xcrun devicectl`. No archive, no export, no upload — the
 * fast inner loop when the phone is on the desk.
 */
import { join, resolve } from 'node:path';
import { localCredentials } from './asc.js';
import type { Boundary } from './boundary.js';
import {
  build,
  buildNumber,
  builtApp,
  generateProject,
  requireToolchain,
  runHook,
} from './build.js';
import { describeTargets, pairedDevices, resolveTargets, type InstallTarget } from './devices.js';
import { assertVariantEntitlements, withEntitlementSwap } from './entitlements.js';
import { fail, type Project } from './project.js';
import { provisionVariant } from './provision.js';
import { cachedSigning, type SigningProfiles } from './signing.js';
import { bundleIdFor } from './variant.js';
import { assertConfiguration } from './xcodeproject.js';

export interface WiredOptions {
  /** Stream the full xcodebuild log instead of the quiet one. */
  verbose?: boolean;
  /** Build somewhere other than the per-variant cache. */
  derivedData?: string;
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
export function derivedDataPath(boundary: Boundary, suffix: string, override?: string): string {
  // An explicit path wins, so a machine with a small home volume, or a CI job
  // with its own cache, can put it somewhere else. Not keyed by variant then:
  // the caller asked for exactly this directory.
  if (override) return resolve(override);
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
 * What will sign this build, decided before anything slow runs.
 *
 * The decision is separated from the act because it is a header fact: a cache
 * hit is instant and can be shown up front, and a miss means minutes of round
 * trips to Apple that deserve a step of their own. `profiles` is null exactly
 * when provisioning still has to happen.
 */
interface SigningPlan {
  decision: 'project' | 'cached' | 'provision';
  profiles: SigningProfiles | null;
  /** The header line — names the profiles, so a cache hit is verifiable. */
  text: string;
  names: string[];
}

function signingPlan(
  boundary: Boundary,
  project: Project,
  options: WiredOptions,
  targets: InstallTarget[],
): SigningPlan {
  if (!options.suffix) {
    return {
      decision: 'project',
      profiles: { byTarget: {} },
      names: [],
      text: "the project's own signing, untouched",
    };
  }

  const cached = options.reprovision
    ? null
    : cachedSigning(boundary, project, {
        suffix: options.suffix,
        deviceUdids: targets.map((target) => target.udid),
        now: boundary.now(),
      });
  if (!cached) {
    return {
      decision: 'provision',
      profiles: null,
      names: [],
      text: options.reprovision
        ? 'provisioning fresh with Apple (--reprovision)'
        : 'no cached profile covers these devices — provisioning with Apple',
    };
  }

  const names = Object.values(cached.byTarget);
  return {
    decision: 'cached',
    profiles: cached,
    names,
    text: `reusing ${names.join(' + ')} (valid, covers ${targets.length} device(s))`,
  };
}

export async function wiredInstall(
  boundary: Boundary,
  project: Project,
  options: WiredOptions,
): Promise<void> {
  const { config } = project;
  const configuration = options.configuration ?? config.configurations.wired;
  assertConfiguration(boundary, project, configuration);
  if (options.suffix && !localCredentials(boundary, config)) {
    fail(
      'a variant build has to register a new bundle id, which needs App Store Connect ' +
        'credentials.\n  Drop the variant to build the plain bundle id instead.',
    );
  }
  // Before provisioning, not when the swap runs: a wrong path would otherwise
  // surface after a bundle id and a profile were already registered at Apple.
  if (options.suffix) assertVariantEntitlements(boundary, project);

  const report = boundary.report;
  await requireToolchain(boundary, project, ['xcodebuild', 'xcrun']);

  const derivedData = derivedDataPath(boundary, options.suffix, options.derivedData);
  const scratch = scratchPath(boundary, options.suffix);
  boundary.fs.rm(scratch, { recursive: true });
  boundary.fs.mkdirp(scratch);

  // Resolve devices and decide on signing BEFORE anything slow — the build, the
  // hooks, provisioning. An unplugged phone then fails in a second instead of
  // after a minute of compiling, and everything a wrong `--suffix` would ruin is
  // on screen before it costs anything.
  const targets = resolveTargets(
    await pairedDevices(boundary, config, scratch),
    options.device ?? '',
  );
  const plan = signingPlan(boundary, project, options, targets);
  const bundleId = bundleIdFor(options.suffix, config);

  report.start({
    command: 'install',
    data: {
      destination: 'device',
      bundleId,
      displayName: options.displayName,
      configuration,
      suffix: options.suffix,
    },
    title: [options.displayName, bundleId, configuration],
    labels: targets.map((target) => target.name),
    rows: [
      {
        label: 'devices',
        text: describeTargets(targets),
        event: 'devices',
        data: {
          devices: targets.map((target) => ({
            id: target.id,
            name: target.name,
            udid: target.udid,
            transport: target.cabled ? 'wired' : 'wifi',
          })),
        },
      },
      {
        label: 'signing',
        text: plan.text,
        event: 'signing',
        data: { decision: plan.decision, profiles: plan.names },
      },
    ],
  });

  if (options.clean) {
    await report.run('clean', 'cleaned', async () => {
      boundary.fs.rm(derivedData, { recursive: true });
    });
  }
  boundary.fs.mkdirp(derivedData);

  // Before provisioning, not after: provisioning READS the project to work out
  // each target's bundle id, and it is the step that mutates the Apple account.
  // A local generate that fails costs nothing; a registration made against a
  // project that was about to change is permanent.
  await generateProject(boundary, project);

  const profiles =
    plan.profiles ??
    (await report.run('provision', 'provisioned', async (step) => {
      const provisioned = await provisionVariant(boundary, project, {
        suffix: options.suffix,
        displayName: options.displayName,
      });
      step.data({ profiles: provisioned.map((profile) => profile.profileName) });
      step.detail(provisioned.map((profile) => profile.profileName).join(' + '));
      return { byTarget: Object.fromEntries(provisioned.map((p) => [p.target, p.profileName])) };
    }));

  await runHook(boundary, project, 'preBuild');

  const request = {
    configuration,
    suffix: options.suffix,
    displayName: options.displayName,
    profiles,
    derivedDataPath: derivedData,
    destination: 'generic/platform=iOS',
    buildNumber: buildNumber(boundary),
    verbose: options.verbose,
  };
  // The swap is restored the moment the build returns — before the install runs
  // — so a failed or hung install can never leave the working tree dirty.
  await withEntitlementSwap(
    boundary,
    project,
    { suffix: options.suffix, backupPath: join(scratch, 'project.pbxproj.orig'), configuration },
    () => build(boundary, project, request),
  );
  const appPath = await builtApp(boundary, project, request, 'iphoneos');

  await runHook(boundary, project, 'postBuild');

  const failures: string[] = [];
  for (const target of targets) {
    const step = report.begin('install', target.name);
    const result = await boundary.exec.run(
      'xcrun',
      ['devicectl', 'device', 'install', 'app', '--device', target.id, appPath],
      { allowFail: true },
    );
    step.data({ device: { id: target.id, name: target.name }, bundleId, appPath });
    if (result.ok) {
      step.ok();
    } else {
      step.fail();
      failures.push(target.name);
    }
  }
  if (failures.length > 0) {
    fail(`${failures.length} of ${targets.length} installs failed: ${failures.join(', ')}`);
  }
  report.done(true, { devices: targets.length, bundleId, appPath });
}
