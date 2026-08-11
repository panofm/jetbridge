/**
 * The cabled install, end to end against the fake boundary — no Xcode, no
 * device, no App Store Connect. The two real side effects the fake cannot know
 * about (devicectl writing its JSON, xcodebuild producing an `.app`) are
 * emulated by wrapping `exec.run`, so the flow runs exactly as it would on a
 * Mac and every argv is asserted where it is produced.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DevicectlDevice } from '../src/devices.js';
import { codeSignLine } from '../src/entitlements.js';
import { projectFrom, type Project } from '../src/project.js';
import { derivedDataPath, scratchPath, wiredInstall } from '../src/wired.js';
import { testConfig } from './helpers/config.js';
import {
  fakeBoundary,
  type FakeBoundary,
  type FakeBoundaryOptions,
} from './helpers/fake-boundary.js';

const HOME = '/home/dev';
const DERIVED_DATA = `${HOME}/Library/Caches/jetbridge/default`;
const APP_PATH = `${DERIVED_DATA}/Build/Products/Debug-iphoneos/Acme.app`;
const PBXPROJ = '/w/ios/Acme.xcodeproj/project.pbxproj';

const project: Project = projectFrom('/w/jetbridge.config.json', testConfig());

const device = (id: string, name: string, transport = 'wired'): DevicectlDevice => ({
  identifier: id,
  deviceProperties: { name },
  hardwareProperties: { deviceType: 'iPhone', udid: `UDID-${id}` },
  connectionProperties: { transportType: transport, pairingState: 'paired' },
});

/**
 * Emulate the side effects the real tools have on the filesystem. Without this
 * `wiredInstall` wipes the scratch directory before `pairedDevices` reads it,
 * so a pre-seeded devices.json would never survive.
 */
function withToolSideEffects(boundary: FakeBoundary, devices: DevicectlDevice[]): FakeBoundary {
  const inner = boundary.exec.run;
  boundary.exec.run = async (command, args, opts) => {
    const result = await inner(command, args, opts);
    if (command === 'xcrun' && args.includes('list') && result.ok) {
      const at = args.indexOf('--json-output');
      if (at !== -1) boundary.fs.write(args[at + 1]!, JSON.stringify({ result: { devices } }));
    }
    if (command === 'xcodebuild' && result.ok) boundary.fs.write(APP_PATH, 'MACH-O');
    return result;
  };
  return boundary;
}

const installStub = (id: string, code = 0) => ({
  match: ['devicectl', 'device', 'install', 'app', '--device', id],
  code,
});

function boundaryFor(devices: DevicectlDevice[], over: FakeBoundaryOptions = {}): FakeBoundary {
  const boundary = fakeBoundary({
    homedir: HOME,
    files: { [PBXPROJ]: '// project', ...over.files },
    commands: over.commands ?? [
      { match: ['command', '-v'] },
      { match: ['xcrun', 'devicectl', 'list', 'devices'] },
      { match: ['xcodebuild', 'build'] },
      ...devices.map((d) => installStub(d.identifier!)),
    ],
    ...(over.env ? { env: over.env } : {}),
  });
  return withToolSideEffects(boundary, devices);
}

const plain = { suffix: '', displayName: 'Acme Dev' };

describe('paths', () => {
  it('keys DerivedData and scratch by variant, under the user cache directory', () => {
    const boundary = fakeBoundary({ homedir: HOME });
    expect(derivedDataPath(boundary, 'wave')).toBe(`${HOME}/Library/Caches/jetbridge/wave`);
    expect(derivedDataPath(boundary, '')).toBe(DERIVED_DATA);
    expect(scratchPath(boundary, 'wave')).toBe(`${HOME}/Library/Caches/jetbridge/.scratch/wave`);
  });
});

describe('preflight', () => {
  it('rejects an unknown configuration, naming the ones that exist', async () => {
    const boundary = boundaryFor([device('DEV-A', 'iPhone A')]);
    await expect(
      wiredInstall(boundary, project, { ...plain, configuration: 'Beta' }),
    ).rejects.toThrow(
      /"Beta" is not one of this project's build configurations \(Debug, Release\)/,
    );
    expect(boundary.calls).toEqual([]);
  });

  it('accepts a configuration the project declares', async () => {
    const boundary = boundaryFor([device('DEV-A', 'iPhone A')], {
      commands: [
        { match: ['command', '-v'] },
        { match: ['xcrun', 'devicectl', 'list', 'devices'] },
        { match: ['xcodebuild', 'build'] },
        installStub('DEV-A'),
      ],
      files: { [`${DERIVED_DATA}/Build/Products/Release-iphoneos/Acme.app`]: 'MACH-O' },
    });
    await expect(
      wiredInstall(boundary, project, { ...plain, configuration: 'Release' }),
    ).resolves.toBeUndefined();
    expect(boundary.findCall('xcodebuild', '-configuration', 'Release')).toBeDefined();
  });

  it('refuses a variant build without App Store Connect credentials, before any build', async () => {
    const boundary = boundaryFor([device('DEV-A', 'iPhone A')]);
    await expect(
      wiredInstall(boundary, project, { suffix: 'wave', displayName: 'Acme Wave' }),
    ).rejects.toThrow(/has to register a new bundle id, which needs App Store Connect credentials/);
    expect(boundary.calls).toEqual([]);
  });

  it('fails when a required binary is missing', async () => {
    const boundary = boundaryFor([device('DEV-A', 'iPhone A')], {
      commands: [{ match: ['command', '-v', 'xcodebuild'] }],
    });
    await expect(wiredInstall(boundary, project, plain)).rejects.toThrow(
      /xcrun was not found on PATH/,
    );
  });
});

describe('ordering', () => {
  it('resolves devices BEFORE running the build', async () => {
    // A full build is a minute; an unplugged phone should fail in a second.
    const boundary = boundaryFor([device('DEV-A', 'iPhone A')]);
    await wiredInstall(boundary, project, plain);
    const lines = boundary.commandLines();
    const listedAt = lines.findIndex((l) => l.startsWith('xcrun devicectl list devices'));
    const builtAt = lines.findIndex((l) => l.startsWith('xcodebuild'));
    expect(listedAt).toBeGreaterThanOrEqual(0);
    expect(builtAt).toBeGreaterThanOrEqual(0);
    expect(listedAt).toBeLessThan(builtAt);
  });

  it('fails on an unreachable device without ever building', async () => {
    const boundary = boundaryFor([
      {
        identifier: 'DEV-A',
        deviceProperties: { name: 'iPhone A' },
        hardwareProperties: { deviceType: 'iPhone', udid: 'UDID-A' },
        connectionProperties: { pairingState: 'paired' },
      },
    ]);
    await expect(wiredInstall(boundary, project, plain)).rejects.toThrow(
      /no paired device is reachable/,
    );
    expect(boundary.commandLines().some((l) => l.startsWith('xcodebuild'))).toBe(false);
  });
});

describe('--clean', () => {
  it('wipes DerivedData, and the build repopulates it', async () => {
    const boundary = boundaryFor([device('DEV-A', 'iPhone A')], {
      files: { [`${DERIVED_DATA}/Build/Intermediates/stale.o`]: 'stale' },
    });
    await wiredInstall(boundary, project, { ...plain, clean: true });
    expect(boundary.fs.exists(`${DERIVED_DATA}/Build/Intermediates/stale.o`)).toBe(false);
    expect(boundary.fs.exists(APP_PATH)).toBe(true);
  });

  it('leaves DerivedData alone without the flag', async () => {
    const boundary = boundaryFor([device('DEV-A', 'iPhone A')], {
      files: { [`${DERIVED_DATA}/Build/Intermediates/stale.o`]: 'stale' },
    });
    await wiredInstall(boundary, project, plain);
    expect(boundary.fs.exists(`${DERIVED_DATA}/Build/Intermediates/stale.o`)).toBe(true);
  });
});

describe('install', () => {
  it('hands devicectl exactly this argv, per device', async () => {
    const boundary = boundaryFor([device('DEV-A', 'iPhone A')]);
    await wiredInstall(boundary, project, plain);
    const call = boundary.findCall('devicectl', 'device', 'install')!;
    expect(call.command).toBe('xcrun');
    expect(call.args).toEqual([
      'devicectl',
      'device',
      'install',
      'app',
      '--device',
      'DEV-A',
      APP_PATH,
    ]);
    // Failures are collected and reported together, not thrown mid-loop.
    expect(call.options.allowFail).toBe(true);
  });

  it('installs to every reachable device', async () => {
    const devices = [device('DEV-A', 'iPhone A'), device('DEV-B', 'iPhone B', 'localNetwork')];
    const boundary = boundaryFor(devices);
    await wiredInstall(boundary, project, plain);
    const installs = boundary.calls.filter((c) => c.args.includes('install'));
    expect(installs.map((c) => c.args[5])).toEqual(['DEV-A', 'DEV-B']);
  });

  it('installs only to the device asked for', async () => {
    const devices = [device('DEV-A', 'iPhone A'), device('DEV-B', 'iPhone B')];
    const boundary = boundaryFor(devices);
    await wiredInstall(boundary, project, { ...plain, device: 'iPhone B' });
    const installs = boundary.calls.filter((c) => c.args.includes('install'));
    expect(installs.map((c) => c.args[5])).toEqual(['DEV-B']);
  });

  it('reports how many installs failed, and which', async () => {
    const devices = [device('DEV-A', 'iPhone A'), device('DEV-B', 'iPhone B')];
    const boundary = boundaryFor(devices, {
      commands: [
        { match: ['command', '-v'] },
        { match: ['xcrun', 'devicectl', 'list', 'devices'] },
        { match: ['xcodebuild', 'build'] },
        installStub('DEV-A'),
        installStub('DEV-B', 1),
      ],
    });
    await expect(wiredInstall(boundary, project, plain)).rejects.toThrow(
      /1 of 2 installs failed: iPhone B/,
    );
  });

  it('still tries every device after one fails', async () => {
    const devices = [device('DEV-A', 'iPhone A'), device('DEV-B', 'iPhone B')];
    const boundary = boundaryFor(devices, {
      commands: [
        { match: ['command', '-v'] },
        { match: ['xcrun', 'devicectl', 'list', 'devices'] },
        { match: ['xcodebuild', 'build'] },
        installStub('DEV-A', 1),
        installStub('DEV-B'),
      ],
    });
    await expect(wiredInstall(boundary, project, plain)).rejects.toThrow(
      /1 of 2 installs failed: iPhone A/,
    );
    expect(boundary.calls.filter((c) => c.args.includes('install'))).toHaveLength(2);
  });

  it('fails when the build reported success but produced no app', async () => {
    const boundary = fakeBoundary({
      homedir: HOME,
      files: { [PBXPROJ]: '// project' },
      commands: [
        { match: ['command', '-v'] },
        { match: ['xcrun', 'devicectl', 'list', 'devices'] },
        { match: ['xcodebuild', 'build'] },
      ],
    });
    // Devices resolve, but nothing emulates xcodebuild's product this time.
    const inner = boundary.exec.run;
    boundary.exec.run = async (command, args, opts) => {
      const result = await inner(command, args, opts);
      const at = args.indexOf('--json-output');
      if (command === 'xcrun' && at !== -1) {
        boundary.fs.write(
          args[at + 1]!,
          JSON.stringify({ result: { devices: [device('DEV-A', 'iPhone A')] } }),
        );
      }
      return result;
    };
    await expect(wiredInstall(boundary, project, plain)).rejects.toThrow(
      new RegExp(`build reported success but produced no app at ${APP_PATH}`),
    );
  });
});

describe('a successful run', () => {
  it('heads the run with the label, the bundle id and the configuration', async () => {
    const boundary = boundaryFor([device('DEV-A', 'iPhone A')]);
    await wiredInstall(boundary, project, plain);
    expect(boundary.humanOutput()).toContain('Acme Dev  ·  io.acme.app.dev  ·  Debug');
  });

  it('names each device as its own step, and closes with a total', async () => {
    const boundary = boundaryFor([device('DEV-A', 'iPhone A')]);
    await wiredInstall(boundary, project, plain);
    const printed = boundary.humanOutput();
    expect(printed).toMatch(/✓ iPhone A/);
    expect(printed).toMatch(/done in /);
  });

  it('runs the configured hooks around the build', async () => {
    const hooked = projectFrom(
      '/w/jetbridge.config.json',
      testConfig({ hooks: { preBuild: 'echo pre', postBuild: 'echo post' } }),
    );
    const boundary = boundaryFor([device('DEV-A', 'iPhone A')], {
      commands: [
        { match: ['command', '-v'] },
        { match: ['/bin/sh', '-c'] },
        { match: ['xcrun', 'devicectl', 'list', 'devices'] },
        { match: ['xcodebuild', 'build'] },
        installStub('DEV-A'),
      ],
    });
    await wiredInstall(boundary, hooked, plain);
    const lines = boundary.commandLines();
    expect(lines.indexOf('/bin/sh -c echo pre')).toBeLessThan(
      lines.findIndex((l) => l.startsWith('xcodebuild')),
    );
    expect(lines.indexOf('/bin/sh -c echo post')).toBeGreaterThan(
      lines.findIndex((l) => l.startsWith('xcodebuild')),
    );
  });

  it('never touches the project file for a plain build', async () => {
    const boundary = boundaryFor([device('DEV-A', 'iPhone A')]);
    await wiredInstall(boundary, project, plain);
    expect(boundary.writes).not.toContain(PBXPROJ);
    expect(boundary.fs.read(PBXPROJ)).toBe('// project');
  });
});

describe('a variant run against cached profiles', () => {
  const SHIPPING = 'ios/Acme/Acme.entitlements';
  const VARIANT = 'ios/Acme/Acme-variant.entitlements';
  const CLEAN_PBXPROJ = `buildSettings = { ${codeSignLine(SHIPPING)} };\n`;
  const SWAPPED_PBXPROJ = `buildSettings = { ${codeSignLine(VARIANT)} };\n`;
  const VARIANT_APP = `${HOME}/Library/Caches/jetbridge/wave/Build/Products/Debug-iphoneos/Acme.app`;
  const PROFILE_DIR = `${HOME}/Library/MobileDevice/Provisioning Profiles`;
  const DER = Buffer.from('der-local').toString('base64');
  const THUMBPRINT = createHash('sha1')
    .update(Buffer.from(DER, 'base64'))
    .digest('hex')
    .toUpperCase();

  /** A cached profile that covers this device, so provisioning is skipped entirely. */
  const CACHED_PROFILE = [
    '<?xml version="1.0"?><plist version="1.0"><dict>',
    '<key>Name</key><string>Acme wave app</string>',
    `<key>ExpirationDate</key><date>${new Date(1_700_000_000_000 + 90 * 86_400_000).toISOString()}</date>`,
    '<key>ProvisionedDevices</key><array><string>UDID-DEV-A</string></array>',
    `<key>DeveloperCertificates</key><array><data>${DER}</data></array>`,
    '</dict></plist>',
  ].join('\n');

  const variantProject = projectFrom(
    '/w/jetbridge.config.json',
    testConfig({
      variant: {
        targets: [{ name: 'Acme', entitlements: SHIPPING, variantEntitlements: VARIANT }],
      },
    }),
  );

  function variantBoundary(): FakeBoundary {
    const boundary = fakeBoundary({
      homedir: HOME,
      env: {
        ASC_API_KEY_ID: 'KEY1',
        ASC_API_ISSUER_ID: 'ISSUER1',
        ASC_API_KEY_PATH: '/keys/AuthKey_KEY1.p8',
      },
      files: {
        [PBXPROJ]: CLEAN_PBXPROJ,
        '/keys/AuthKey_KEY1.p8': 'PEM',
        [`${PROFILE_DIR}/app.mobileprovision`]: 'CMS BYTES',
      },
      commands: [
        { match: ['command', '-v'] },
        { match: ['xcrun', 'devicectl', 'list', 'devices'] },
        { match: ['security', 'find-identity'], stdout: `1) ${THUMBPRINT} "Apple Development"` },
        { match: ['security', 'cms'], stdout: CACHED_PROFILE },
        { match: ['xcodebuild', 'build'] },
        installStub('DEV-A'),
      ],
    });
    const inner = boundary.exec.run;
    boundary.exec.run = async (command, args, opts) => {
      const result = await inner(command, args, opts);
      const at = args.indexOf('--json-output');
      if (command === 'xcrun' && at !== -1) {
        boundary.fs.write(
          args[at + 1]!,
          JSON.stringify({ result: { devices: [device('DEV-A', 'iPhone A')] } }),
        );
      }
      if (command === 'xcodebuild' && result.ok) boundary.fs.write(VARIANT_APP, 'MACH-O');
      return result;
    };
    return boundary;
  }

  const variantOptions = { suffix: 'wave', displayName: 'Acme Wave' };

  it('skips provisioning and never calls App Store Connect', async () => {
    const boundary = variantBoundary();
    await wiredInstall(boundary, variantProject, variantOptions);
    expect(boundary.requests).toEqual([]);
  });

  it('builds against the cached profile, with reduced entitlements patched in', async () => {
    const boundary = variantBoundary();
    let duringBuild = '';
    const inner = boundary.exec.run;
    boundary.exec.run = async (command, args, opts) => {
      if (command === 'xcodebuild') duringBuild = boundary.fs.read(PBXPROJ);
      return inner(command, args, opts);
    };
    await wiredInstall(boundary, variantProject, variantOptions);
    expect(duringBuild).toBe(SWAPPED_PBXPROJ);
    expect(boundary.findCall('xcodebuild', 'JETBRIDGE_PROFILE_APP=Acme wave app')).toBeDefined();
    expect(boundary.findCall('xcodebuild', 'JETBRIDGE_SUFFIX=.wave')).toBeDefined();
  });

  it('restores the project file BEFORE the install runs', async () => {
    // A hung or failed install must never leave reduced entitlements in the
    // working tree, where `git add -A` would commit them.
    const boundary = variantBoundary();
    let duringInstall = '';
    const inner = boundary.exec.run;
    boundary.exec.run = async (command, args, opts) => {
      if (args.includes('install')) duringInstall = boundary.fs.read(PBXPROJ);
      return inner(command, args, opts);
    };
    await wiredInstall(boundary, variantProject, variantOptions);
    expect(duringInstall).toBe(CLEAN_PBXPROJ);
    expect(boundary.fs.read(PBXPROJ)).toBe(CLEAN_PBXPROJ);
  });

  it('installs the variant bundle id, and says so before the build', async () => {
    const boundary = variantBoundary();
    await wiredInstall(boundary, variantProject, variantOptions);
    expect(boundary.findCall('devicectl', 'device', 'install')!.args).toContain(VARIANT_APP);
    expect(boundary.humanOutput()).toContain('Acme Wave  ·  io.acme.app.dev.wave  ·  Debug');
  });

  it('names the profiles it reused, so a cache hit is not a guess', async () => {
    const boundary = variantBoundary();
    await wiredInstall(boundary, variantProject, variantOptions);
    expect(boundary.humanOutput()).toContain('reusing Acme wave app (valid, covers 1 device(s))');
  });
});
