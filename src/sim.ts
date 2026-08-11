/**
 * The simulator install: build for `iphonesimulator`, then install and launch on
 * one simulator with `simctl`. The path with no hardware in it.
 *
 * One thing separates it from the cabled install, and it is the whole point: a
 * SIMULATOR VALIDATES NO CODE SIGNATURE. This flow therefore needs no
 * certificate, no provisioning profile, no App Store Connect key and no
 * entitlement swap — `provisionVariant` is never called from here. So a
 * `--suffix` variant runs on a simulator on a machine that has never been near
 * the developer account, where `jetbridge wired` refuses without credentials.
 */
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
import { fail, type Project } from './project.js';
import {
  bootSimulator,
  installApp,
  launchApp,
  listSimulators,
  resolveSimulator,
} from './simulator.js';
import { bundleIdFor } from './variant.js';
import { derivedDataPath } from './wired.js';

export interface SimOptions {
  suffix: string;
  displayName: string;
  /** A simulator name or udid. Empty picks a booted-or-available default. */
  device?: string;
  configuration?: string;
  /** Wipe the cached DerivedData first, for a genuinely corrupt build. */
  clean?: boolean;
}

export async function simInstall(
  boundary: Boundary,
  project: Project,
  options: SimOptions,
): Promise<void> {
  const { config } = project;
  const configuration = options.configuration ?? config.configurations.sim;
  if (!config.configurations.available.includes(configuration)) {
    fail(
      `"${configuration}" is not one of this project's build configurations ` +
        `(${config.configurations.available.join(', ')})`,
    );
  }

  await requireToolchain(boundary, project, ['xcodebuild', 'xcrun']);
  await generateProject(boundary, project);
  await runHook(boundary, project, 'preBuild');

  // Resolve and boot BEFORE the slow build: a simulator name nobody has fails in
  // a second instead of after a minute of compiling, and the boot finishes while
  // xcodebuild works.
  const simulator = resolveSimulator(
    boundary,
    await listSimulators(boundary),
    config,
    options.device ?? '',
  );
  await bootSimulator(boundary, simulator);

  const derivedData = derivedDataPath(boundary, options.suffix);
  if (options.clean) {
    boundary.log.info('--clean: wiping DerivedData for a build from scratch');
    boundary.fs.rm(derivedData, { recursive: true });
  }
  boundary.fs.mkdirp(derivedData);

  const request = {
    configuration,
    suffix: options.suffix,
    displayName: options.displayName,
    // Empty on purpose: nothing signs a simulator build, so there is no profile
    // to point it at and `provisionVariant` is never called from this flow.
    profiles: { byTarget: {} },
    derivedDataPath: derivedData,
    destination: `platform=iOS Simulator,id=${simulator.udid}`,
    buildNumber: buildNumber(boundary),
  };
  await build(boundary, project, request);

  const appPath = productPath(request, config, 'iphonesimulator');
  if (!boundary.fs.exists(appPath)) {
    fail(`the build reported success but produced no app at ${appPath}`);
  }
  boundary.log.info(`built → ${appPath}`);

  await runHook(boundary, project, 'postBuild');

  const bundleId = bundleIdFor(options.suffix, config);
  boundary.log.step(`installing ${bundleId} → ${simulator.name}`);
  await installApp(boundary, simulator, appPath);
  await launchApp(boundary, simulator, bundleId);

  boundary.log.info(
    `installed + launched ${bundleId} ("${options.displayName}") → ${simulator.name}`,
  );
  if (options.suffix && !localCredentials(boundary, config)) {
    boundary.log.info(
      'no App Store Connect credentials here — fine for a simulator, but `jetbridge wired` needs them.',
    );
  }
}
