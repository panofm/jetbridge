/**
 * The simulator flow. The claim worth protecting is the one in the module
 * comment: it reaches App Store Connect never, and signs nothing — so it works
 * on a machine with no credentials at all.
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { projectFrom } from '../src/project.js';
import { simInstall } from '../src/sim.js';
import { settingsJson } from './helpers/build-settings.js';
import { fakeBoundary } from './helpers/fake-boundary.js';
import { testConfig } from './helpers/config.js';
import { PBXPROJ, PBXPROJ_PATH } from './helpers/pbxproj.js';

const config = testConfig({
  variant: { displayName: 'Acme Dev', targets: [{ name: 'Acme' }] },
  hooks: { preBuild: 'echo before', postBuild: 'echo after' },
});

const project = projectFrom('/w/jetbridge.config.json', config);

const SIM_LIST = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
      {
        udid: 'UDID-BOOTED',
        name: 'iPhone 17 Pro',
        state: 'Booted',
        isAvailable: true,
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      },
      {
        udid: 'UDID-COLD',
        name: 'iPhone 16',
        state: 'Shutdown',
        isAvailable: true,
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
      },
    ],
  },
});

const appAt = (suffix: string): string =>
  `/home/dev/Library/Caches/jetbridge/${suffix || 'default'}/Build/Products/Debug-iphonesimulator/Acme.app`;

/** No credentials in the environment, on purpose — that is the point of the flow. */
const boundaryFor = (suffix: string) =>
  fakeBoundary({
    homedir: '/home/dev',
    files: {
      [`/w/${PBXPROJ_PATH}`]: PBXPROJ,
      [`${appAt(suffix)}/Info.plist`]: '<plist/>',
    },
    commands: [{ match: ['xcrun', 'simctl', 'list'], stdout: SIM_LIST }],
    defaultCommandResult: { code: 0 },
  });

describe('simInstall', () => {
  it('builds for the simulator, then installs and launches', async () => {
    const boundary = boundaryFor('wave');
    await simInstall(boundary, project, { suffix: 'wave', displayName: 'Acme Wave' });
    const lines = boundary.commandLines();
    expect(lines).toContain(`xcrun simctl install UDID-BOOTED ${appAt('wave')}`);
    expect(lines).toContain('xcrun simctl launch UDID-BOOTED io.acme.app.dev.wave');
  });

  it('installs the app the build settings name, when it is not named for the scheme', async () => {
    const renamed = appAt('wave').replace(/Acme\.app$/, 'Wave.app');
    const boundary = fakeBoundary({
      homedir: '/home/dev',
      files: {
        [`/w/${PBXPROJ_PATH}`]: PBXPROJ,
        // A stale build from before PRODUCT_NAME changed.
        [`${appAt('wave')}/Info.plist`]: '<plist/>',
        [`${renamed}/Info.plist`]: '<plist/>',
      },
      commands: [
        { match: ['xcrun', 'simctl', 'list'], stdout: SIM_LIST },
        {
          match: ['xcodebuild', '-showBuildSettings'],
          stdout: settingsJson({ target: 'Acme', product: 'Wave.app' }),
        },
      ],
      defaultCommandResult: { code: 0 },
    });
    await simInstall(boundary, project, { suffix: 'wave', displayName: 'Acme Wave' });
    expect(boundary.commandLines()).toContain(`xcrun simctl install UDID-BOOTED ${renamed}`);
  });

  it('pins the build destination to the resolved simulator', async () => {
    const boundary = boundaryFor('wave');
    await simInstall(boundary, project, { suffix: 'wave', displayName: 'Acme Wave' });
    const build = boundary.findCall('xcodebuild', '-destination')!;
    expect(build.args[build.args.indexOf('-destination') + 1]).toBe(
      'platform=iOS Simulator,id=UDID-BOOTED',
    );
  });

  it('builds the configured simulator configuration', async () => {
    const boundary = boundaryFor('wave');
    await simInstall(boundary, project, { suffix: 'wave', displayName: 'Acme Wave' });
    const build = boundary.findCall('xcodebuild', '-configuration')!;
    expect(build.args[build.args.indexOf('-configuration') + 1]).toBe('Debug');
  });

  it('honours an explicit configuration', async () => {
    const release = testConfig({
      configurations: { sim: 'Debug' },
      variant: { displayName: 'Acme Dev', targets: [{ name: 'Acme' }] },
    });
    const boundary = fakeBoundary({
      homedir: '/home/dev',
      files: {
        '/w/ios/Acme.xcodeproj': 'x',
        '/home/dev/Library/Caches/jetbridge/default/Build/Products/Release-iphonesimulator/Acme.app/Info.plist':
          '<plist/>',
      },
      commands: [{ match: ['xcrun', 'simctl', 'list'], stdout: SIM_LIST }],
      defaultCommandResult: { code: 0 },
    });
    await simInstall(boundary, projectFrom('/w/jetbridge.config.json', release), {
      suffix: '',
      displayName: 'Acme Dev',
      configuration: 'Release',
    });
    const build = boundary.findCall('xcodebuild', '-configuration')!;
    expect(build.args[build.args.indexOf('-configuration') + 1]).toBe('Release');
  });

  it('rejects a configuration the project does not have', async () => {
    const boundary = boundaryFor('wave');
    await expect(
      simInstall(boundary, project, {
        suffix: 'wave',
        displayName: 'Acme Wave',
        configuration: 'Beta',
      }),
    ).rejects.toThrow(
      /"Beta" is not one of this project's build configurations \(Debug, Release, Staging\)/,
    );
  });

  it('never talks to App Store Connect', async () => {
    const boundary = boundaryFor('wave');
    await simInstall(boundary, project, { suffix: 'wave', displayName: 'Acme Wave' });
    expect(boundary.requests).toEqual([]);
  });

  it('never reads a signing identity — a simulator validates no signature', async () => {
    const boundary = boundaryFor('wave');
    await simInstall(boundary, project, { suffix: 'wave', displayName: 'Acme Wave' });
    expect(boundary.commandLines().filter((line) => line.startsWith('security'))).toEqual([]);
  });

  it('installs a variant with no credentials in the environment', async () => {
    const boundary = boundaryFor('wave');
    await expect(
      simInstall(boundary, project, { suffix: 'wave', displayName: 'Acme Wave' }),
    ).resolves.toBeUndefined();
  });

  it('provisions nothing even on a machine that HAS credentials', async () => {
    // The invariant is that this flow never provisions — not merely that the
    // test machine has no key to provision with.
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const boundary = fakeBoundary({
      homedir: '/home/dev',
      env: { ASC_API_KEY_ID: 'KEY1', ASC_API_ISSUER_ID: 'ISSUER1' },
      files: {
        '/w/ios/Acme.xcodeproj': 'x',
        '/home/dev/.appstoreconnect/private_keys/AuthKey_KEY1.p8': privateKey
          .export({ type: 'pkcs8', format: 'pem' })
          .toString(),
        [`${appAt('wave')}/Info.plist`]: '<plist/>',
      },
      commands: [{ match: ['xcrun', 'simctl', 'list'], stdout: SIM_LIST }],
      defaultCommandResult: { code: 0 },
    });
    await simInstall(boundary, project, { suffix: 'wave', displayName: 'Acme Wave' });
    expect(boundary.requests).toEqual([]);
    expect(boundary.findCall('security')).toBeUndefined();
    expect(boundary.findCall('xcodebuild', 'build')!.args).not.toContain('JETBRIDGE_PROFILE_APP');
  });

  it('passes no provisioning profile to the build', async () => {
    const boundary = boundaryFor('wave');
    await simInstall(boundary, project, { suffix: 'wave', displayName: 'Acme Wave' });
    const build = boundary.findCall('xcodebuild', 'build')!;
    expect(build.args.some((arg) => arg.startsWith('JETBRIDGE_PROFILE_'))).toBe(false);
    expect(build.args).not.toContain('-authenticationKeyPath');
  });

  it('carries the variant bundle suffix and label into the build', async () => {
    const boundary = boundaryFor('wave');
    await simInstall(boundary, project, { suffix: 'wave', displayName: 'Acme Wave' });
    const build = boundary.findCall('xcodebuild', 'build')!;
    expect(build.args).toContain('JETBRIDGE_SUFFIX=.wave');
    expect(build.args).toContain('JETBRIDGE_DISPLAY_NAME=Acme Wave');
  });

  it('boots a simulator that is shut down', async () => {
    const boundary = boundaryFor('wave');
    await simInstall(boundary, project, {
      suffix: 'wave',
      displayName: 'Acme Wave',
      device: 'iPhone 16',
    });
    expect(boundary.commandLines()).toContain('xcrun simctl boot UDID-COLD');
  });

  it('does not boot one that is already booted', async () => {
    const boundary = boundaryFor('wave');
    await simInstall(boundary, project, { suffix: 'wave', displayName: 'Acme Wave' });
    expect(boundary.findCall('xcrun', 'simctl', 'boot')).toBeUndefined();
  });

  it('fails on an unknown simulator before it builds anything', async () => {
    const boundary = boundaryFor('wave');
    await expect(
      simInstall(boundary, project, {
        suffix: 'wave',
        displayName: 'Acme Wave',
        device: 'iPhone 99',
      }),
    ).rejects.toThrow(/is not an available simulator name or udid/);
    expect(boundary.findCall('xcodebuild', 'build')).toBeUndefined();
  });

  it('runs the preBuild and postBuild hooks', async () => {
    const boundary = boundaryFor('wave');
    await simInstall(boundary, project, { suffix: 'wave', displayName: 'Acme Wave' });
    const lines = boundary.commandLines();
    expect(lines).toContain('/bin/sh -c echo before');
    expect(lines).toContain('/bin/sh -c echo after');
  });

  /**
   * A fresh clone of a generated project: `project.yml` is committed and the
   * `.xcodeproj` is not. Refusing here would refuse the exact run jetbridge was
   * configured to make work, so the toolchain check has to let it through and
   * `generateProject` has to get its turn.
   */
  it('generates first on a fresh clone, instead of refusing a missing project', async () => {
    const generated = testConfig({
      project: { xcodeproj: undefined, xcodegen: true },
      variant: { displayName: 'Acme Dev', targets: [{ name: 'Acme' }] },
    });
    const boundary = boundaryFor('wave');
    boundary.fs.rm('/w/ios/Acme.xcodeproj', { recursive: true });
    boundary.fs.write('/w/ios/project.yml', 'name: Acme\n');
    // The stub writes nothing, so the run still ends short — but it ends AFTER
    // xcodegen was given its chance, which is the whole point.
    await expect(
      simInstall(boundary, projectFrom('/w/jetbridge.config.json', generated, boundary), {
        suffix: 'wave',
        displayName: 'Acme Wave',
      }),
    ).rejects.toThrow(/the project has not been generated[\s\S]*xcodegen generate/);
    expect(boundary.commandLines()).toContain('xcodegen generate');
  });

  it('names xcodegen when the project is generated but xcodegen is off', async () => {
    const boundary = boundaryFor('wave');
    boundary.fs.rm('/w/ios/Acme.xcodeproj', { recursive: true });
    boundary.fs.write('/w/ios/project.yml', 'name: Acme\n');
    const notGenerating = testConfig({
      project: { xcodeproj: undefined },
      variant: { displayName: 'Acme Dev', targets: [{ name: 'Acme' }] },
    });
    await expect(
      simInstall(boundary, projectFrom('/w/jetbridge.config.json', notGenerating, boundary), {
        suffix: 'wave',
        displayName: 'Acme Wave',
      }),
    ).rejects.toThrow(/Run `xcodegen generate` in \/w\/ios, or set project\.xcodegen/);
    expect(boundary.commandLines()).not.toContain('xcodegen generate');
  });

  it('regenerates the project when the config says it is generated', async () => {
    const generated = testConfig({
      project: { xcodegen: true },
      variant: { displayName: 'Acme Dev', targets: [{ name: 'Acme' }] },
    });
    const boundary = boundaryFor('wave');
    boundary.fs.write('/w/ios/project.yml', 'name: Acme\n');
    await simInstall(boundary, projectFrom('/w/jetbridge.config.json', generated), {
      suffix: 'wave',
      displayName: 'Acme Wave',
    });
    expect(boundary.commandLines()).toContain('xcodegen generate');
  });

  it('wipes DerivedData on --clean — the stale product goes with it', async () => {
    const boundary = boundaryFor('wave');
    await expect(
      simInstall(boundary, project, { suffix: 'wave', displayName: 'Acme Wave', clean: true }),
    ).rejects.toThrow(/produced no app/);
    expect(boundary.files.has(`${appAt('wave')}/Info.plist`)).toBe(false);
  });

  it('says so when the build produces no app', async () => {
    const boundary = fakeBoundary({
      homedir: '/home/dev',
      files: { '/w/ios/Acme.xcodeproj': 'x' },
      commands: [{ match: ['xcrun', 'simctl', 'list'], stdout: SIM_LIST }],
      defaultCommandResult: { code: 0 },
    });
    await expect(
      simInstall(boundary, project, { suffix: 'wave', displayName: 'Acme Wave' }),
    ).rejects.toThrow(/reported success but produced no app/);
  });
});
