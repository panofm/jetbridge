/**
 * The device layer decides which phones a build is pushed to. Getting it wrong
 * is quiet rather than loud — a filter that drops a reachable device sends a
 * round of testing to a phone that never received the build — so the accessors,
 * the availability rule and the selection are all pinned here.
 */
import { describe, expect, it } from 'vitest';
import {
  describeTargets,
  idOf,
  isAvailable,
  isCabled,
  nameOf,
  pairedDevices,
  resolveTargets,
  transportLabel,
  transportOf,
  udidOf,
  type DevicectlDevice,
} from '../src/devices.js';
import { testConfig } from './helpers/config.js';
import { fakeBoundary, type FakeBoundary } from './helpers/fake-boundary.js';

/** The fake keeps its log lines private, so tests that read them swap in their own. */
function captureLogs(boundary: FakeBoundary): string[] {
  const lines: string[] = [];
  boundary.log = {
    info: (m) => lines.push(m),
    warn: (m) => lines.push(m),
    error: (m) => lines.push(m),
    step: (m) => lines.push(m),
  };
  return lines;
}

interface DeviceSpec {
  id?: string;
  name?: string;
  udid?: string;
  serial?: string;
  deviceType?: string;
  transport?: string;
  pairingState?: string;
  tunnelState?: string;
}

const device = (spec: DeviceSpec = {}): DevicectlDevice => ({
  ...(spec.id === undefined ? {} : { identifier: spec.id }),
  ...(spec.name === undefined ? {} : { deviceProperties: { name: spec.name } }),
  hardwareProperties: {
    deviceType: spec.deviceType ?? 'iPhone',
    ...(spec.udid === undefined ? {} : { udid: spec.udid }),
    ...(spec.serial === undefined ? {} : { serialNumber: spec.serial }),
  },
  connectionProperties: {
    ...(spec.transport === undefined ? {} : { transportType: spec.transport }),
    pairingState: spec.pairingState ?? 'paired',
    ...(spec.tunnelState === undefined ? {} : { tunnelState: spec.tunnelState }),
  },
});

const cabled = (over: DeviceSpec = {}): DevicectlDevice =>
  device({ id: 'DEV-A', name: 'iPhone A', udid: 'UDID-A', transport: 'wired', ...over });

const overWifi = (over: DeviceSpec = {}): DevicectlDevice =>
  device({ id: 'DEV-B', name: 'iPhone B', udid: 'UDID-B', transport: 'localNetwork', ...over });

describe('accessors', () => {
  it('reads the identifier, name, UDID and transport', () => {
    const one = cabled();
    expect(idOf(one)).toBe('DEV-A');
    expect(nameOf(one)).toBe('iPhone A');
    expect(udidOf(one)).toBe('UDID-A');
    expect(transportOf(one)).toBe('wired');
  });

  it('falls back rather than throwing on a device missing every field', () => {
    expect(idOf({})).toBe('');
    expect(udidOf({})).toBe('');
    expect(transportOf({})).toBe('');
    // A name is printed in a list, so it gets a placeholder instead of a blank.
    expect(nameOf({})).toBe('?');
  });

  it('keeps the UDID and the identifier apart — a profile lists the UDID', () => {
    const one = device({ id: 'IDENTIFIER', udid: 'UDID' });
    expect(idOf(one)).not.toBe(udidOf(one));
    expect(udidOf(one)).toBe('UDID');
  });
});

describe('isAvailable', () => {
  it('accepts a paired device with a transport', () => {
    expect(isAvailable(cabled())).toBe(true);
    expect(isAvailable(overWifi())).toBe(true);
  });

  it('accepts a cabled device whose debug tunnel is disconnected', () => {
    // Documented past bug: gating on tunnelState hid every device, because the
    // tunnel only opens when `devicectl device install` asks for one.
    expect(isAvailable(cabled({ tunnelState: 'disconnected' }))).toBe(true);
  });

  it('rejects a paired device with no transport', () => {
    expect(isAvailable(device({ id: 'DEV-C', name: 'iPhone C' }))).toBe(false);
  });

  it('rejects an unpaired device even when it has a transport', () => {
    expect(isAvailable(cabled({ pairingState: 'unpaired' }))).toBe(false);
    expect(isAvailable({ connectionProperties: { transportType: 'wired' } })).toBe(false);
  });
});

describe('isCabled', () => {
  it('is true only for the wired transport', () => {
    expect(isCabled(cabled())).toBe(true);
    expect(isCabled(overWifi())).toBe(false);
    expect(isCabled({})).toBe(false);
  });
});

describe('transportLabel', () => {
  it('names the transport, and says so when there is none', () => {
    expect(transportLabel(cabled())).toBe('wired');
    expect(transportLabel(overWifi())).toBe('Wi-Fi');
    expect(transportLabel(device({ id: 'DEV-C' }))).toBe('unavailable');
    expect(transportLabel(cabled({ pairingState: 'unpaired' }))).toBe('unavailable');
  });
});

describe('pairedDevices', () => {
  const listStub = { match: ['xcrun', 'devicectl', 'list', 'devices'] };
  const payload = (devices: DevicectlDevice[]): string => JSON.stringify({ result: { devices } });

  it('returns the devices devicectl wrote, and asks for JSON on a path', async () => {
    const boundary = fakeBoundary({
      files: { '/scratch/devices.json': payload([cabled(), overWifi()]) },
      commands: [listStub],
    });
    const found = await pairedDevices(boundary, testConfig(), '/scratch');
    expect(found.map(idOf)).toEqual(['DEV-A', 'DEV-B']);
    expect(boundary.findCall('xcrun', 'devicectl', 'list', 'devices')!.args).toEqual([
      'devicectl',
      'list',
      'devices',
      '--json-output',
      '/scratch/devices.json',
    ]);
  });

  it('drops a device type this project does not target', async () => {
    // devicectl reports an iPad's platform as iOS too, so an iPhone-only
    // project must not sweep a paired iPad into its install set.
    const boundary = fakeBoundary({
      files: {
        '/scratch/devices.json': payload([
          cabled(),
          device({ id: 'PAD', name: 'iPad Pro', deviceType: 'iPad', transport: 'wired' }),
        ]),
      },
      commands: [listStub],
    });
    const found = await pairedDevices(boundary, testConfig(), '/scratch');
    expect(found.map(nameOf)).toEqual(['iPhone A']);
  });

  it('keeps an iPad when the project targets one', async () => {
    const boundary = fakeBoundary({
      files: {
        '/scratch/devices.json': payload([
          cabled(),
          device({ id: 'PAD', name: 'iPad Pro', deviceType: 'iPad', transport: 'wired' }),
        ]),
      },
      commands: [listStub],
    });
    const config = testConfig({ project: { deviceTypes: ['iPhone', 'iPad'] } });
    const found = await pairedDevices(boundary, config, '/scratch');
    expect(found.map(nameOf)).toEqual(['iPhone A', 'iPad Pro']);
  });

  it('drops a device reporting no type at all', async () => {
    const boundary = fakeBoundary({
      files: { '/scratch/devices.json': payload([{ identifier: 'BARE' }]) },
      commands: [listStub],
    });
    expect(await pairedDevices(boundary, testConfig(), '/scratch')).toEqual([]);
  });

  it('says how to pair when devicectl fails', async () => {
    const boundary = fakeBoundary({
      files: { '/scratch/devices.json': payload([cabled()]) },
      commands: [{ ...listStub, code: 1, stderr: 'no devices' }],
    });
    await expect(pairedDevices(boundary, testConfig(), '/scratch')).rejects.toThrow(
      /is a device paired\?/,
    );
  });

  it('fails when devicectl reports success but writes no JSON', async () => {
    const boundary = fakeBoundary({ commands: [listStub] });
    await expect(pairedDevices(boundary, testConfig(), '/scratch')).rejects.toThrow(
      /`devicectl list devices` failed/,
    );
  });

  it('survives malformed JSON with a message about the output', async () => {
    const boundary = fakeBoundary({
      files: { '/scratch/devices.json': '{ this is not json' },
      commands: [listStub],
    });
    await expect(pairedDevices(boundary, testConfig(), '/scratch')).rejects.toThrow(
      /produced output that is not JSON/,
    );
  });

  it('returns an empty list when the JSON carries no devices key', async () => {
    const boundary = fakeBoundary({
      files: { '/scratch/devices.json': '{}' },
      commands: [listStub],
    });
    expect(await pairedDevices(boundary, testConfig(), '/scratch')).toEqual([]);
  });
});

describe('resolveTargets', () => {
  it('takes every reachable device when no filter is given', () => {
    const targets = resolveTargets(
      [cabled(), overWifi(), device({ id: 'DEV-C', name: 'iPhone C' })],
      '',
    );
    expect(targets).toEqual([
      { id: 'DEV-A', name: 'iPhone A', udid: 'UDID-A', cabled: true },
      { id: 'DEV-B', name: 'iPhone B', udid: 'UDID-B', cabled: false },
    ]);
  });

  it('takes a Wi-Fi device even when another is cabled', () => {
    // A cabled-only filter would be satisfied by the cabled device and drop the
    // Wi-Fi one without a word.
    const targets = resolveTargets([cabled(), overWifi()], '');
    expect(targets.map((t) => t.id)).toContain('DEV-B');
  });

  it('prints nothing at all — the caller renders the header', () => {
    const boundary = fakeBoundary();
    const logs = captureLogs(boundary);
    resolveTargets([cabled(), overWifi()], '');
    expect(logs).toEqual([]);
    expect(boundary.humanOutput()).toBe('');
  });

  it('matches a filter against the identifier, name, UDID or serial', () => {
    const devices = [cabled({ serial: 'SERIAL-A' }), overWifi()];
    for (const filter of ['DEV-A', 'iPhone A', 'UDID-A', 'SERIAL-A']) {
      expect(resolveTargets(devices, filter).map((t) => t.id)).toEqual(['DEV-A']);
    }
  });

  it('names the paired devices when the filter matches nothing', () => {
    expect(() => resolveTargets([cabled(), overWifi()], 'iPhone Z')).toThrow(
      /--device iPhone Z is not a paired device\.\n {2}Paired: iPhone A \[wired\], iPhone B \[Wi-Fi\]/,
    );
  });

  it('says what to do when the named device has no transport', () => {
    expect(() => resolveTargets([device({ id: 'DEV-C', name: 'iPhone C' })], 'DEV-C')).toThrow(
      /iPhone C is paired but has no transport — plug it in, or join it to Wi-Fi\./,
    );
  });

  it('fails when nothing at all is reachable', () => {
    expect(() => resolveTargets([device({ id: 'DEV-C', name: 'iPhone C' })], '')).toThrow(
      /no paired device is reachable/,
    );
  });

  it('mentions the OTA escape hatch when nothing is reachable', () => {
    expect(() => resolveTargets([], '')).toThrow(/jetbridge ota` needs no device at all/);
  });

  it('carries the UDID through, because the signing cache checks it', () => {
    expect(resolveTargets([cabled()], '')[0]!.udid).toBe('UDID-A');
  });
});

describe('describeTargets', () => {
  const target = (name: string, cabled: boolean) => ({ id: name, name, udid: name, cabled });

  it('is a bare list when every device is on a cable', () => {
    expect(describeTargets([target('iPhone A', true), target('iPhone B', true)])).toBe(
      'iPhone A, iPhone B',
    );
  });

  it('says which devices are on the slow path', () => {
    expect(describeTargets([target('iPhone A', true), target('iPhone B', false)])).toBe(
      'iPhone A, iPhone B  (iPhone B over Wi-Fi — cable them for the fast loop)',
    );
  });

  it('does not name them one by one when they are all on Wi-Fi', () => {
    expect(describeTargets([target('iPhone A', false)])).toBe(
      'iPhone A  (over Wi-Fi — cable them for the fast loop)',
    );
    expect(describeTargets([target('iPhone A', false), target('iPhone B', false)])).toBe(
      'iPhone A, iPhone B  (both over Wi-Fi — cable them for the fast loop)',
    );
    expect(
      describeTargets([
        target('iPhone A', false),
        target('iPhone B', false),
        target('iPhone C', false),
      ]),
    ).toBe('iPhone A, iPhone B, iPhone C  (all over Wi-Fi — cable them for the fast loop)');
  });
});
