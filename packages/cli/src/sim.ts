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
  describeSimulator,
  installApp,
  launchApp,
  listSimulators,
  resolveSimulator,
} from './simulator.js';
import { bundleIdFor } from './variant.js';
import { derivedDataPath } from './wired.js';
import { assertConfiguration } from './xcodeproject.js';

export interface SimOptions {
  /** Stream the full xcodebuild log instead of the quiet one. */
  verbose?: boolean;
  /** Build somewhere other than the per-variant cache. */
  derivedData?: string;
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
  assertConfiguration(boundary, project, configuration);

  const report = boundary.report;
  await requireToolchain(boundary, project, ['xcodebuild', 'xcrun']);

  // Resolve BEFORE the slow build: a simulator name nobody has fails in a second
  // instead of after a minute of compiling.
  const simulator = resolveSimulator(await listSimulators(boundary), config, options.device ?? '');
  const bundleId = bundleIdFor(options.suffix, config);

  report.start({
    command: 'install',
    data: {
      destination: 'simulator',
      bundleId,
      displayName: options.displayName,
      configuration,
      suffix: options.suffix,
    },
    title: [options.displayName, bundleId, configuration],
    labels: [simulator.name],
    rows: [
      {
        label: 'simulator',
        text: describeSimulator(simulator),
        event: 'devices',
        data: {
          devices: [{ id: simulator.udid, name: simulator.name, transport: 'simulator' }],
        },
      },
      {
        label: 'signing',
        text: 'none — a simulator validates no code signature',
        event: 'signing',
        data: { decision: 'none', profiles: [] },
      },
    ],
  });

  // The boot finishes while xcodebuild works, so it is started before the build
  // and never waited on again.
  await report.run('boot', 'booted', () => bootSimulator(boundary, simulator));

  const derivedData = derivedDataPath(boundary, options.suffix, options.derivedData);
  if (options.clean) {
    await report.run('clean', 'cleaned', async () => {
      boundary.fs.rm(derivedData, { recursive: true });
    });
  }
  boundary.fs.mkdirp(derivedData);

  await generateProject(boundary, project);
  await runHook(boundary, project, 'preBuild');

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
    verbose: options.verbose,
  };
  await build(boundary, project, request);

  const appPath = productPath(request, config, 'iphonesimulator');
  if (!boundary.fs.exists(appPath)) {
    fail(`the build reported success but produced no app at ${appPath}`);
  }

  await runHook(boundary, project, 'postBuild');

  await report.run('install', simulator.name, async (step) => {
    step.data({ device: { id: simulator.udid, name: simulator.name }, bundleId, appPath });
    await installApp(boundary, simulator, appPath);
    await launchApp(boundary, simulator, bundleId);
  });

  if (options.suffix && !localCredentials(boundary, config)) {
    report.note(
      'no App Store Connect credentials here — fine for a simulator, but a device install needs them.',
    );
  }
  report.done(true, { devices: 1, bundleId, appPath });
}
