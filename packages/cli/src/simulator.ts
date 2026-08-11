/**
 * Simulators, through `xcrun simctl`.
 *
 * Only what delivering a build to a simulator needs: find one, boot it, install
 * the `.app`, launch it. Screenshots, permission grants and UI automation are
 * somebody else's tool.
 */
import type { Boundary } from './boundary.js';
import type { Config } from './config.js';
import { fail } from './project.js';

export interface Simulator {
  udid: string;
  name: string;
  /** `Booted`, `Shutdown`, `Booting`, … — whatever simctl reports. */
  state: string;
  /** False when the runtime behind it is not installed; it cannot be booted. */
  available: boolean;
  /** e.g. `com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro`. */
  deviceTypeIdentifier: string;
  /** The runtime this simulator is listed under. */
  runtime: string;
}

interface SimctlDevice {
  udid?: string;
  name?: string;
  state?: string;
  isAvailable?: boolean;
  deviceTypeIdentifier?: string;
}

interface SimctlList {
  /** Runtime identifier → the simulators on it. */
  devices?: Record<string, SimctlDevice[]>;
}

export const isBooted = (simulator: Simulator): boolean => simulator.state === 'Booted';

export async function listSimulators(boundary: Boundary): Promise<Simulator[]> {
  const result = await boundary.exec.run('xcrun', ['simctl', 'list', 'devices', '-j'], {
    allowFail: true,
  });
  if (!result.ok) {
    fail(
      '`simctl list devices` failed — are the Xcode command line tools selected?\n' +
        '  Run `sudo xcode-select -s /Applications/Xcode.app`, then re-run.',
    );
  }
  let parsed: SimctlList;
  try {
    parsed = JSON.parse(result.stdout) as SimctlList;
  } catch {
    return fail('`simctl list devices` produced output that is not JSON');
  }
  const simulators: Simulator[] = [];
  for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
    for (const device of devices) {
      if (!device.udid) continue;
      simulators.push({
        udid: device.udid,
        name: device.name ?? '?',
        state: device.state ?? 'Unknown',
        available: device.isAvailable ?? true,
        deviceTypeIdentifier: device.deviceTypeIdentifier ?? '',
        runtime,
      });
    }
  }
  return simulators;
}

/**
 * Does this simulator model a device type the project targets? Matched against
 * the device-type identifier rather than the display name, so `iPhone 17 Pro`
 * and `iPhone Air` both answer to `iPhone` without a list of model names.
 */
const matchesProjectDeviceType = (simulator: Simulator, config: Config): boolean =>
  config.project.deviceTypes.some((type) =>
    simulator.deviceTypeIdentifier.includes(`SimDeviceType.${type}`),
  );

/**
 * The simulator this install goes to: the one named, or a sensible default.
 *
 * A booted simulator wins the default, because it is the one already on screen
 * — installing into a second, invisible simulator looks exactly like an install
 * that silently did nothing.
 */
export function resolveSimulator(
  boundary: Boundary,
  simulators: Simulator[],
  config: Config,
  wanted: string,
): Simulator {
  if (wanted) {
    const match =
      simulators.find((simulator) => simulator.udid === wanted) ??
      simulators.find((simulator) => simulator.name === wanted && simulator.available);
    if (!match) {
      const names = simulators
        .filter((simulator) => simulator.available)
        .map((simulator) => `${simulator.name} (${simulator.udid})`);
      fail(
        `--device ${wanted} is not an available simulator name or udid.\n` +
          `  Available: ${names.join(', ') || '(none — install a runtime in Xcode › Settings › Components)'}`,
      );
    }
    if (!match.available) {
      fail(
        `simulator ${match.name} (${match.udid}) is unavailable — its runtime is not installed.\n` +
          '  Install it in Xcode › Settings › Components, or name another simulator.',
      );
    }
    return match;
  }

  const candidates = simulators.filter(
    (simulator) => simulator.available && matchesProjectDeviceType(simulator, config),
  );
  const chosen = candidates.find(isBooted) ?? candidates[0];
  if (!chosen) {
    fail(
      `no available ${config.project.deviceTypes.join('/')} simulator is installed.\n` +
        '  Add one in Xcode › Settings › Components, or name one with --device.',
    );
  }
  boundary.log.info(
    `simulator: ${chosen.name} (${chosen.udid})${isBooted(chosen) ? ' — already booted' : ''}`,
  );
  return chosen;
}

/** Booting an already-booted simulator is success, not an error. */
export async function bootSimulator(boundary: Boundary, simulator: Simulator): Promise<void> {
  if (isBooted(simulator)) return;
  boundary.log.step(`booting ${simulator.name}`);
  const result = await boundary.exec.run('xcrun', ['simctl', 'boot', simulator.udid], {
    allowFail: true,
  });
  // simctl races itself: something else (Xcode, a previous run) can boot the
  // device between the listing and this call, and it says so rather than
  // shrugging.
  if (!result.ok && !/current state: Booted/i.test(result.stderr || result.stdout)) {
    fail(
      `could not boot ${simulator.name} (${simulator.udid}).\n` +
        `  Try \`xcrun simctl shutdown ${simulator.udid}\` and re-run.`,
    );
  }
}

export async function installApp(
  boundary: Boundary,
  simulator: Simulator,
  appPath: string,
): Promise<void> {
  const result = await boundary.exec.run('xcrun', ['simctl', 'install', simulator.udid, appPath], {
    allowFail: true,
  });
  if (!result.ok) {
    fail(
      `could not install ${appPath} on ${simulator.name}:\n` +
        `  ${(result.stderr || result.stdout).trim()}`,
    );
  }
}

export async function launchApp(
  boundary: Boundary,
  simulator: Simulator,
  bundleId: string,
): Promise<void> {
  // A running app refuses to be launched again, and the copy on screen is the
  // one that was just replaced. Terminating first is what makes the new build
  // the one you see.
  await boundary.exec.run('xcrun', ['simctl', 'terminate', simulator.udid, bundleId], {
    allowFail: true,
  });
  const result = await boundary.exec.run('xcrun', ['simctl', 'launch', simulator.udid, bundleId], {
    allowFail: true,
  });
  if (!result.ok) {
    fail(
      `installed ${bundleId} but could not launch it on ${simulator.name}:\n` +
        `  ${(result.stderr || result.stdout).trim()}\n` +
        '  Open it from the simulator home screen to see why.',
    );
  }
}
