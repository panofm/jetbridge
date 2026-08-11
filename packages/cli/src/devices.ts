/**
 * Paired devices, through `xcrun devicectl`.
 *
 * Lives apart from the install flow because the wizard needs the device list
 * before it can offer a cabled install at all — and it must be the same list
 * the install later pushes to.
 */
import { join } from 'node:path';
import type { Boundary } from './boundary.js';
import type { Config } from './config.js';
import { fail } from './project.js';

export interface DevicectlDevice {
  identifier?: string;
  deviceProperties?: { name?: string };
  hardwareProperties?: {
    platform?: string;
    deviceType?: string;
    serialNumber?: string;
    /** The Apple UDID a provisioning profile lists — NOT `identifier`. */
    udid?: string;
  };
  connectionProperties?: {
    /** `wired` (cable) or `localNetwork` (Wi-Fi). Absent when unreachable. */
    transportType?: string;
    pairingState?: string;
    /** The debug tunnel, opened on demand — not an attachment signal. */
    tunnelState?: string;
  };
}

interface DevicectlOutput {
  result?: { devices?: DevicectlDevice[] };
}

export const idOf = (device: DevicectlDevice): string => device.identifier ?? '';
export const udidOf = (device: DevicectlDevice): string => device.hardwareProperties?.udid ?? '';
export const nameOf = (device: DevicectlDevice): string => device.deviceProperties?.name ?? '?';
export const transportOf = (device: DevicectlDevice): string =>
  device.connectionProperties?.transportType ?? '';

/**
 * Can devicectl install to this device right now?
 *
 * Deliberately NOT `tunnelState === 'connected'`: that describes the debug
 * tunnel, which stays disconnected until something opens one, and `devicectl
 * device install` opens it on demand. Gating on it hides every device — a
 * cabled iPhone reporting `wired` + `disconnected` installs fine.
 */
export const isAvailable = (device: DevicectlDevice): boolean =>
  device.connectionProperties?.pairingState === 'paired' && transportOf(device) !== '';

/** Attached by cable, as opposed to paired over Wi-Fi (`localNetwork`). */
export const isCabled = (device: DevicectlDevice): boolean => transportOf(device) === 'wired';

export const transportLabel = (device: DevicectlDevice): string => {
  if (!isAvailable(device)) return 'unavailable';
  return isCabled(device) ? 'wired' : 'Wi-Fi';
};

/** Every paired device of a type this project targets. */
export async function pairedDevices(
  boundary: Boundary,
  config: Config,
  scratchDir: string,
): Promise<DevicectlDevice[]> {
  const jsonPath = join(scratchDir, 'devices.json');
  boundary.fs.mkdirp(scratchDir);
  const result = await boundary.exec.run('xcrun', [
    'devicectl',
    'list',
    'devices',
    '--json-output',
    jsonPath,
  ]);
  if (!result.ok || !boundary.fs.exists(jsonPath)) {
    fail(
      '`devicectl list devices` failed — is a device paired?\n' +
        '  Pair one in Xcode (Window › Devices and Simulators), then re-run.',
    );
  }
  let parsed: DevicectlOutput;
  try {
    parsed = JSON.parse(boundary.fs.read(jsonPath)) as DevicectlOutput;
  } catch {
    return fail('`devicectl list devices` produced output that is not JSON');
  }
  const wanted = new Set<string>(config.project.deviceTypes);
  return (parsed.result?.devices ?? []).filter((device) =>
    wanted.has(device.hardwareProperties?.deviceType ?? ''),
  );
}

export interface InstallTarget {
  id: string;
  name: string;
  /** Checked against a cached profile's device list before signing. */
  udid: string;
  /** Attached by cable. A Wi-Fi install is minutes rather than seconds. */
  cabled: boolean;
}

/** `DEV-A  iPhone A  [wired]`, for an error that has no header to point at. */
const describe = (device: DevicectlDevice): string =>
  `${nameOf(device)} [${transportLabel(device)}]`;

/**
 * The devices line of the header: who is getting this build, and whether any of
 * them is on the slow path.
 *
 * Said out loud because a Wi-Fi install takes minutes rather than seconds, and a
 * silent one reads as a hang.
 */
export function describeTargets(targets: InstallTarget[]): string {
  const names = targets.map((target) => target.name).join(', ');
  const overTheAir = targets.filter((target) => !target.cabled);
  if (overTheAir.length === 0) return names;
  const all = ['', 'both ', 'all '][Math.min(targets.length, 3) - 1]!;
  const which =
    overTheAir.length === targets.length
      ? all
      : `${overTheAir.map((target) => target.name).join(', ')} `;
  return `${names}  (${which}over Wi-Fi — cable them for the fast loop)`;
}

/**
 * Which devices this install goes to: every reachable one, or the single device
 * asked for.
 *
 * Reachability is the filter, not cabling. Taking cabled devices only sounds
 * right for a mode called "wired", but the phone on the desk is sometimes on
 * Wi-Fi — and with a second device cabled, a cabled-only filter is satisfied,
 * so the Wi-Fi one gets dropped without a word and the "plug something in" hint
 * never fires. Rounds of device testing then go to a phone that never received
 * the build.
 *
 * Pure: it prints nothing. The caller renders the devices into the header it
 * puts up before the build, and a failure here names the devices inline instead.
 */
export function resolveTargets(devices: DevicectlDevice[], deviceFilter: string): InstallTarget[] {
  let selected: DevicectlDevice[];
  if (deviceFilter) {
    // Match any identifier a person might reach for.
    selected = devices.filter(
      (device) =>
        idOf(device) === deviceFilter ||
        nameOf(device) === deviceFilter ||
        udidOf(device) === deviceFilter ||
        device.hardwareProperties?.serialNumber === deviceFilter,
    );
    if (selected.length === 0) {
      fail(
        `--device ${deviceFilter} is not a paired device.\n` +
          `  Paired: ${devices.map(describe).join(', ') || '(none)'}`,
      );
    }
    const [only] = selected;
    if (only && !isAvailable(only)) {
      fail(`${nameOf(only)} is paired but has no transport — plug it in, or join it to Wi-Fi.`);
    }
  } else {
    selected = devices.filter(isAvailable);
    if (selected.length === 0) {
      fail(
        "no paired device is reachable — plug one in, or join it to this Mac's Wi-Fi.\n" +
          `  Paired: ${devices.map(describe).join(', ') || '(none)'}\n` +
          '  (`jetbridge ota` needs no device at all)',
      );
    }
  }
  return selected.map((device) => ({
    id: idOf(device),
    name: nameOf(device),
    udid: udidOf(device),
    cabled: isCabled(device),
  }));
}
