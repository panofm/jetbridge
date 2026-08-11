/**
 * simctl handling, asserted as argv against a fake. Nothing here boots a real
 * simulator, so the tests run on a machine without Xcode.
 */
import { describe, expect, it } from 'vitest';
import {
  bootSimulator,
  installApp,
  isBooted,
  launchApp,
  listSimulators,
  resolveSimulator,
  type Simulator,
} from '../src/simulator.js';
import { fakeBoundary } from './helpers/fake-boundary.js';
import { testConfig } from './helpers/config.js';

const config = testConfig();

const simctlJson = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
      {
        udid: 'UDID-PHONE',
        name: 'iPhone 17 Pro',
        state: 'Shutdown',
        isAvailable: true,
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      },
      {
        udid: 'UDID-PAD',
        name: 'iPad Pro 11-inch',
        state: 'Booted',
        isAvailable: true,
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11',
      },
      {
        udid: 'UDID-OLD',
        name: 'iPhone 12',
        state: 'Shutdown',
        isAvailable: false,
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-12',
      },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-25-0': [
      {
        udid: 'UDID-BOOTED',
        name: 'iPhone 16',
        state: 'Booted',
        isAvailable: true,
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
      },
    ],
  },
});

const listing = (stdout: string = simctlJson) =>
  fakeBoundary({ commands: [{ match: ['xcrun', 'simctl', 'list'], stdout }] });

const sim = (overrides: Partial<Simulator> = {}): Simulator => ({
  udid: 'UDID-PHONE',
  name: 'iPhone 17 Pro',
  state: 'Shutdown',
  available: true,
  deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
  runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0',
  ...overrides,
});

describe('listSimulators', () => {
  it('flattens every runtime into one list', async () => {
    const simulators = await listSimulators(listing());
    expect(simulators.map((s) => s.udid)).toEqual([
      'UDID-PHONE',
      'UDID-PAD',
      'UDID-OLD',
      'UDID-BOOTED',
    ]);
  });

  it('asks simctl for JSON', async () => {
    const boundary = listing();
    await listSimulators(boundary);
    expect(boundary.commandLines()).toContain('xcrun simctl list devices -j');
  });

  it('keeps the runtime each simulator was listed under', async () => {
    const simulators = await listSimulators(listing());
    expect(simulators.at(-1)!.runtime).toBe('com.apple.CoreSimulator.SimRuntime.iOS-25-0');
  });

  it('says what to do when simctl is not usable', async () => {
    const boundary = fakeBoundary({
      commands: [{ match: ['xcrun', 'simctl', 'list'], code: 72, stderr: 'no Xcode' }],
    });
    await expect(listSimulators(boundary)).rejects.toThrow(/xcode-select/);
  });

  it('fails clearly on output that is not JSON', async () => {
    await expect(listSimulators(listing('not json'))).rejects.toThrow(/is not JSON/);
  });
});

describe('resolveSimulator', () => {
  it('resolves by name', async () => {
    const boundary = listing();
    const simulators = await listSimulators(boundary);
    expect(resolveSimulator(boundary, simulators, config, 'iPhone 16').udid).toBe('UDID-BOOTED');
  });

  it('resolves by udid', async () => {
    const boundary = listing();
    const simulators = await listSimulators(boundary);
    expect(resolveSimulator(boundary, simulators, config, 'UDID-PHONE').name).toBe('iPhone 17 Pro');
  });

  it('lists what is available when the name does not exist', async () => {
    const boundary = listing();
    const simulators = await listSimulators(boundary);
    expect(() => resolveSimulator(boundary, simulators, config, 'iPhone 99')).toThrow(
      /is not an available simulator name or udid[\s\S]*iPhone 17 Pro/,
    );
  });

  it('refuses a udid whose runtime is not installed', async () => {
    const boundary = listing();
    const simulators = await listSimulators(boundary);
    expect(() => resolveSimulator(boundary, simulators, config, 'UDID-OLD')).toThrow(
      /runtime is not installed/,
    );
  });

  it('defaults to a booted simulator of a targeted device type', async () => {
    const boundary = listing();
    const simulators = await listSimulators(boundary);
    // The iPad is booted first in the listing, but this project targets iPhone.
    expect(resolveSimulator(boundary, simulators, config, '').udid).toBe('UDID-BOOTED');
  });

  it('falls back to the first available one when none is booted', async () => {
    const boundary = listing();
    const simulators = (await listSimulators(boundary)).map((s) => ({ ...s, state: 'Shutdown' }));
    expect(resolveSimulator(boundary, simulators, config, '').udid).toBe('UDID-PHONE');
  });

  it('says which simulator it chose', async () => {
    const boundary = listing();
    const messages: string[] = [];
    boundary.log.info = (m) => messages.push(m);
    resolveSimulator(boundary, await listSimulators(boundary), config, '');
    expect(messages.join('\n')).toContain('iPhone 16 (UDID-BOOTED)');
  });

  it('honours the project device types', async () => {
    const boundary = listing();
    const simulators = await listSimulators(boundary);
    const iPadOnly = testConfig({ project: { deviceTypes: ['iPad'] } });
    expect(resolveSimulator(boundary, simulators, iPadOnly, '').udid).toBe('UDID-PAD');
  });

  it('says what to do when nothing is installed', () => {
    const boundary = fakeBoundary();
    expect(() => resolveSimulator(boundary, [], config, '')).toThrow(
      /no available iPhone simulator is installed/,
    );
  });
});

describe('bootSimulator', () => {
  it('boots a shutdown simulator', async () => {
    const boundary = fakeBoundary({ commands: [{ match: ['xcrun', 'simctl', 'boot'] }] });
    await bootSimulator(boundary, sim());
    expect(boundary.commandLines()).toContain('xcrun simctl boot UDID-PHONE');
  });

  it('does nothing when it is already booted', async () => {
    const boundary = fakeBoundary();
    await bootSimulator(boundary, sim({ state: 'Booted' }));
    expect(boundary.calls).toHaveLength(0);
  });

  it('treats a simulator booted underneath it as success', async () => {
    const boundary = fakeBoundary({
      commands: [
        {
          match: ['xcrun', 'simctl', 'boot'],
          code: 149,
          stderr: 'Unable to boot device in current state: Booted',
        },
      ],
    });
    await expect(bootSimulator(boundary, sim())).resolves.toBeUndefined();
  });

  it('says what to do when the boot genuinely fails', async () => {
    const boundary = fakeBoundary({
      commands: [{ match: ['xcrun', 'simctl', 'boot'], code: 1, stderr: 'device is wedged' }],
    });
    await expect(bootSimulator(boundary, sim())).rejects.toThrow(/simctl shutdown UDID-PHONE/);
  });
});

describe('installApp', () => {
  it('installs the app by path', async () => {
    const boundary = fakeBoundary({ commands: [{ match: ['xcrun', 'simctl', 'install'] }] });
    await installApp(boundary, sim(), '/dd/Build/Products/Debug-iphonesimulator/Acme.app');
    expect(boundary.calls[0]).toMatchObject({
      command: 'xcrun',
      args: [
        'simctl',
        'install',
        'UDID-PHONE',
        '/dd/Build/Products/Debug-iphonesimulator/Acme.app',
      ],
    });
  });

  it('reports a failed install', async () => {
    const boundary = fakeBoundary({
      commands: [{ match: ['xcrun', 'simctl', 'install'], code: 1, stderr: 'invalid bundle' }],
    });
    await expect(installApp(boundary, sim(), '/dd/Acme.app')).rejects.toThrow(/invalid bundle/);
  });
});

describe('launchApp', () => {
  it('terminates the running copy before launching the new one', async () => {
    const boundary = fakeBoundary({
      commands: [
        { match: ['xcrun', 'simctl', 'terminate'] },
        { match: ['xcrun', 'simctl', 'launch'] },
      ],
    });
    await launchApp(boundary, sim(), 'io.acme.app.dev.wave');
    expect(boundary.commandLines()).toEqual([
      'xcrun simctl terminate UDID-PHONE io.acme.app.dev.wave',
      'xcrun simctl launch UDID-PHONE io.acme.app.dev.wave',
    ]);
  });

  it('ignores a terminate that had nothing to terminate', async () => {
    const boundary = fakeBoundary({
      commands: [
        { match: ['xcrun', 'simctl', 'terminate'], code: 3, stderr: 'found nothing to terminate' },
        { match: ['xcrun', 'simctl', 'launch'] },
      ],
    });
    await expect(launchApp(boundary, sim(), 'io.acme.app.dev')).resolves.toBeUndefined();
  });

  it('says the install worked when only the launch failed', async () => {
    const boundary = fakeBoundary({
      commands: [
        { match: ['xcrun', 'simctl', 'terminate'] },
        { match: ['xcrun', 'simctl', 'launch'], code: 4, stderr: 'not found' },
      ],
    });
    await expect(launchApp(boundary, sim(), 'io.acme.app.dev')).rejects.toThrow(
      /installed io\.acme\.app\.dev but could not launch it/,
    );
  });
});

describe('isBooted', () => {
  it('is true only for the Booted state', () => {
    expect(isBooted(sim({ state: 'Booted' }))).toBe(true);
    expect(isBooted(sim({ state: 'Booting' }))).toBe(false);
  });
});
