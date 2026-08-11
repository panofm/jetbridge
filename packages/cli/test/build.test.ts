/**
 * Everything xcodebuild is told to do is assembled in `buildArgs`, so the argv
 * array is asserted whole rather than probed with `toContain` — an argument
 * that silently moves or disappears is exactly the failure this catches.
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  authArgs,
  explainBuildFailure,
  build,
  buildArgs,
  buildNumber,
  generateProject,
  productPath,
  requireToolchain,
  runHook,
  type BuildRequest,
} from '../src/build.js';
import { projectFrom, type Project } from '../src/project.js';
import { testConfig } from './helpers/config.js';
import { fakeBoundary, type FakeBoundary } from './helpers/fake-boundary.js';
import { PROJECT_FILES } from './helpers/pbxproj.js';

/** Reads the project file, which is where the extension bundle ids live. */
const readsProject = (): FakeBoundary => fakeBoundary({ files: PROJECT_FILES });

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const projectOf = (overrides: Record<string, unknown> = {}): Project =>
  projectFrom('/w/jetbridge.config.json', testConfig(overrides));

const request = (over: Partial<BuildRequest> = {}): BuildRequest => ({
  configuration: 'Debug',
  suffix: '',
  displayName: 'Acme Dev',
  profiles: { byTarget: {} },
  derivedDataPath: '/dd',
  destination: 'generic/platform=iOS',
  buildNumber: '1700000000',
  ...over,
});

/** A boundary that finds App Store Connect credentials on this machine. */
const withCredentials = (): FakeBoundary =>
  fakeBoundary({
    env: {
      ASC_API_KEY_ID: 'KEY1',
      ASC_API_ISSUER_ID: 'ISSUER1',
      ASC_API_KEY_PATH: '/keys/AuthKey_KEY1.p8',
    },
    files: { '/keys/AuthKey_KEY1.p8': KEY_PEM },
  });

describe('buildNumber', () => {
  it('comes from the injected clock', () => {
    expect(buildNumber(fakeBoundary({ now: 1_712_345_678 }))).toBe('1712345678');
  });

  it('changes between runs, so iOS never skips the install as already-current', () => {
    expect(buildNumber(fakeBoundary({ now: 100 }))).not.toBe(
      buildNumber(fakeBoundary({ now: 101 })),
    );
  });
});

describe('authArgs', () => {
  it('is empty when this machine has no credentials', () => {
    expect(authArgs(fakeBoundary(), testConfig())).toEqual([]);
  });

  it('carries the key path, id and issuer id', () => {
    expect(authArgs(withCredentials(), testConfig())).toEqual([
      '-authenticationKeyPath',
      '/keys/AuthKey_KEY1.p8',
      '-authenticationKeyID',
      'KEY1',
      '-authenticationKeyIssuerID',
      'ISSUER1',
    ]);
  });
});

describe('buildArgs', () => {
  it('is exactly this argv for a plain build', () => {
    expect(buildArgs(fakeBoundary(), projectOf(), request())).toEqual([
      'build',
      '-project',
      '/w/ios/Acme.xcodeproj',
      '-scheme',
      'Acme',
      '-configuration',
      'Debug',
      '-destination',
      'generic/platform=iOS',
      '-derivedDataPath',
      '/dd',
      'CURRENT_PROJECT_VERSION=1700000000',
      'DEBUG_INFORMATION_FORMAT=dwarf',
      // No suffix, so no bundle suffix and no signing settings — but the label
      // is still passed, because a plain build sets it too.
      'JETBRIDGE_DISPLAY_NAME=Acme Dev',
      '-allowProvisioningUpdates',
      '-quiet',
    ]);
  });

  it('is exactly this argv for a variant build', () => {
    const project = projectOf({
      variant: {
        targets: [{ name: 'Acme' }, { name: 'Upload Widget', bundleIdSuffix: 'uploadwidget' }],
      },
    });
    const args = buildArgs(
      readsProject(),
      project,
      request({
        suffix: 'wave',
        displayName: 'Acme Wave',
        profiles: {
          byTarget: { Acme: 'Acme wave app', 'Upload Widget': 'Acme wave uploadwidget' },
        },
      }),
    );
    expect(args).toEqual([
      'build',
      '-project',
      '/w/ios/Acme.xcodeproj',
      '-scheme',
      'Acme',
      '-configuration',
      'Debug',
      '-destination',
      'generic/platform=iOS',
      '-derivedDataPath',
      '/dd',
      'CURRENT_PROJECT_VERSION=1700000000',
      'DEBUG_INFORMATION_FORMAT=dwarf',
      'JETBRIDGE_SUFFIX=.wave',
      'JETBRIDGE_DISPLAY_NAME=Acme Wave',
      'JETBRIDGE_SIGN_STYLE=Manual',
      'JETBRIDGE_PROFILE_APP=Acme wave app',
      'JETBRIDGE_PROFILE_UPLOADWIDGET=Acme wave uploadwidget',
      '-allowProvisioningUpdates',
      '-quiet',
    ]);
  });

  it('skips the separate dSYM by default, and keeps it when asked', () => {
    expect(buildArgs(fakeBoundary(), projectOf(), request())).toContain(
      'DEBUG_INFORMATION_FORMAT=dwarf',
    );
    expect(buildArgs(fakeBoundary(), projectOf(), request({ withDsym: true }))).not.toContain(
      'DEBUG_INFORMATION_FORMAT=dwarf',
    );
  });

  it('leaves variant and signing settings out of a plain build', () => {
    const project = projectOf({ variant: { targets: [{ name: 'Acme' }] } });
    const args = buildArgs(
      fakeBoundary(),
      project,
      request({ profiles: { byTarget: { Acme: 'Acme wave app' } } }),
    );
    expect(args.some((a) => a.startsWith('JETBRIDGE_SUFFIX'))).toBe(false);
    expect(args.some((a) => a.startsWith('JETBRIDGE_SIGN_STYLE'))).toBe(false);
    expect(args.some((a) => a.startsWith('JETBRIDGE_PROFILE_'))).toBe(false);
  });

  it('stamps the git sha as JETBRIDGE_GIT_SHA', () => {
    expect(buildArgs(fakeBoundary(), projectOf(), request({ gitSha: 'abc1234' }))).toContain(
      'JETBRIDGE_GIT_SHA=abc1234',
    );
  });

  it('omits the git sha setting entirely when there is none', () => {
    expect(
      buildArgs(fakeBoundary(), projectOf(), request()).some((a) =>
        a.startsWith('JETBRIDGE_GIT_SHA'),
      ),
    ).toBe(false);
  });

  it('builds a workspace project with -workspace, not -project', () => {
    const project = projectOf({
      project: { xcodeproj: undefined, xcworkspace: 'Acme.xcworkspace' },
    });
    const args = buildArgs(fakeBoundary(), project, request());
    expect(args.slice(0, 3)).toEqual(['build', '-workspace', '/w/ios/Acme.xcworkspace']);
    expect(args).not.toContain('-project');
  });

  it('appends the authentication flags when credentials exist', () => {
    const args = buildArgs(withCredentials(), projectOf(), request());
    expect(args.slice(-8)).toEqual([
      '-allowProvisioningUpdates',
      '-authenticationKeyPath',
      '/keys/AuthKey_KEY1.p8',
      '-authenticationKeyID',
      'KEY1',
      '-authenticationKeyIssuerID',
      'ISSUER1',
      '-quiet',
    ]);
  });
});

describe('productPath', () => {
  it('points at the device build product', () => {
    expect(productPath(request(), testConfig(), 'iphoneos')).toBe(
      '/dd/Build/Products/Debug-iphoneos/Acme.app',
    );
  });

  it('points at the simulator build product for the same configuration', () => {
    expect(
      productPath(request({ configuration: 'Release' }), testConfig(), 'iphonesimulator'),
    ).toBe('/dd/Build/Products/Release-iphonesimulator/Acme.app');
  });
});

describe('requireToolchain', () => {
  const projectFile = { '/w/ios/Acme.xcodeproj/project.pbxproj': '// project' };

  it('passes when every binary is on PATH and the project exists', async () => {
    const boundary = fakeBoundary({
      files: projectFile,
      commands: [{ match: ['command', '-v'] }],
    });
    await expect(
      requireToolchain(boundary, projectOf(), ['xcodebuild', 'xcrun']),
    ).resolves.toBeUndefined();
    expect(boundary.commandLines()).toEqual(['command -v xcodebuild', 'command -v xcrun']);
  });

  it('names the missing binary', async () => {
    const boundary = fakeBoundary({
      files: projectFile,
      commands: [{ match: ['command', '-v', 'xcodebuild'] }],
    });
    await expect(requireToolchain(boundary, projectOf(), ['xcodebuild', 'xcrun'])).rejects.toThrow(
      /xcrun was not found on PATH/,
    );
  });

  it('names the missing project and points at the config', async () => {
    const boundary = fakeBoundary({ commands: [{ match: ['command', '-v'] }] });
    await expect(requireToolchain(boundary, projectOf(), [])).rejects.toThrow(
      /missing \/w\/ios\/Acme\.xcodeproj\.\n {2}Check project\.iosDir and project\.xcodeproj in the config\./,
    );
  });

  it('tells a generated project to generate first', async () => {
    // A spec beside the project means the .xcodeproj is generated output, so
    // the fix is to generate it rather than to correct a path.
    const boundary = fakeBoundary({
      commands: [{ match: ['command', '-v'] }],
      files: { '/w/ios/project.yml': 'name: Acme\n' },
    });
    await expect(requireToolchain(boundary, projectOf(), [])).rejects.toThrow(
      /Run `xcodegen generate` in \/w\/ios, or set project\.xcodegen/,
    );
  });
});

describe('generateProject', () => {
  it('does nothing unless the project is generated', async () => {
    const boundary = fakeBoundary();
    await generateProject(boundary, projectOf());
    expect(boundary.calls).toEqual([]);
  });

  it('runs xcodegen in the Xcode project directory', async () => {
    const boundary = fakeBoundary({
      commands: [{ match: ['xcodegen', 'generate'] }],
      files: { '/w/ios/project.yml': 'name: Acme\n' },
    });
    const project = projectOf({ project: { xcodegen: true } });
    await generateProject(boundary, project);
    const call = boundary.findCall('xcodegen', 'generate')!;
    expect(call.args).toEqual(['generate']);
    expect(call.options.cwd).toBe('/w/ios');
  });

  it('fails loudly, carrying xcodegen output', async () => {
    const boundary = fakeBoundary({
      commands: [{ match: ['xcodegen'], code: 1, stderr: 'Spec parsing error: no such target\n' }],
      files: { '/w/ios/project.yml': 'name: Acme\n' },
    });
    const project = projectOf({ project: { xcodegen: true } });
    await expect(generateProject(boundary, project)).rejects.toThrow(
      /xcodegen failed:\nSpec parsing error: no such target/,
    );
  });
});

describe('runHook', () => {
  it('does nothing when no hook is configured', async () => {
    const boundary = fakeBoundary();
    await runHook(boundary, projectOf(), 'preBuild');
    expect(boundary.calls).toEqual([]);
  });

  it('runs the hook through /bin/sh in the project root', async () => {
    const boundary = fakeBoundary({ commands: [{ match: ['/bin/sh', '-c'] }] });
    const project = projectOf({ hooks: { preBuild: 'npm run codegen && echo done' } });
    await runHook(boundary, project, 'preBuild');
    const call = boundary.calls[0]!;
    expect(call.command).toBe('/bin/sh');
    expect(call.args).toEqual(['-c', 'npm run codegen && echo done']);
    expect(call.options.cwd).toBe('/w');
    // Captured, not inherited: a hook that prints lands between a step's line
    // and its duration, and its own banner repeats the one the runner drew.
    expect(call.options.stdio).toBeUndefined();
  });

  it('runs the postBuild hook, not the preBuild one', async () => {
    const boundary = fakeBoundary({ commands: [{ match: ['/bin/sh'] }] });
    const project = projectOf({ hooks: { preBuild: 'pre', postBuild: 'post' } });
    await runHook(boundary, project, 'postBuild');
    expect(boundary.calls[0]!.args).toEqual(['-c', 'post']);
  });

  it('fails with the exit code and the command that produced it', async () => {
    const boundary = fakeBoundary({ commands: [{ match: ['/bin/sh'], code: 3 }] });
    const project = projectOf({ hooks: { preBuild: 'exit 3' } });
    await expect(runHook(boundary, project, 'preBuild')).rejects.toThrow(
      /the preBuild hook failed \(exit 3\): exit 3/,
    );
  });
});

describe('build', () => {
  /** A hundred lines of noise, with the real error at the very bottom. */
  const noisyOutput = [
    ...Array.from({ length: 100 }, (_, i) => `note: line ${i} of xcodebuild chatter`),
    'ContentView.swift:12:5: error: cannot find "foo" in scope',
    '** BUILD FAILED **',
  ].join('\n');

  it('runs xcodebuild in the project root and returns the result', async () => {
    const boundary = fakeBoundary({ commands: [{ match: ['xcodebuild', 'build'], stdout: 'ok' }] });
    const result = await build(boundary, projectOf(), request());
    expect(result.ok).toBe(true);
    expect(boundary.calls[0]!.options.cwd).toBe('/w');
  });

  it('quotes the error lines, not a blind tail of chatter', async () => {
    // `-quiet` leaves a failure reading only "** ARCHIVE FAILED **", which
    // names nothing. A real run hit exactly that and had to be diagnosed by
    // rerunning the build by hand.
    const boundary = fakeBoundary({
      commands: [{ match: ['xcodebuild'], code: 65, stdout: noisyOutput }],
    });
    const error = await build(boundary, projectOf(), request()).catch((e: Error) => e);
    const message = (error as Error).message;
    expect(message).toContain('cannot find "foo" in scope');
    expect(message).not.toContain('line 0 of xcodebuild chatter');
  });

  it('reads both streams, because xcodebuild puts errors on stdout', async () => {
    const boundary = fakeBoundary({
      commands: [
        {
          match: ['xcodebuild'],
          code: 65,
          stdout: 'A.swift:1:1: error: from stdout',
          stderr: 'B.swift:2:2: error: from stderr',
        },
      ],
    });
    const error = await build(boundary, projectOf(), request()).catch((e: Error) => e);
    const message = (error as Error).message;
    expect(message).toContain('from stdout');
    expect(message).toContain('from stderr');
  });
});

describe('explainBuildFailure', () => {
  it('picks out compiler errors', () => {
    const explained = explainBuildFailure('noise\nA.swift:3:1: error: no such thing\nmore', '');
    expect(explained).toBe('A.swift:3:1: error: no such thing');
  });

  it('picks out signing failures, which never say "error"', () => {
    // These are most of what actually goes wrong here, and a blind tail misses
    // every one of them.
    for (const line of [
      "No profiles for 'io.acme.app.dev.wave' were found",
      'Provisioning profile "Acme wave app" doesn\'t include signing certificate',
      'Signing for "Acme" requires a provisioning profile',
    ]) {
      expect(explainBuildFailure(`chatter\n${line}\nchatter`, '')).toContain(line);
    }
  });

  it('collapses the same error repeated per target', () => {
    const repeated = Array.from({ length: 6 }, () => 'A.swift:1:1: error: same').join('\n');
    expect(explainBuildFailure(repeated, '').split('\n')).toHaveLength(1);
  });

  it('falls back to the tail, and says the log is available', () => {
    const explained = explainBuildFailure('just\nchatter\n** ARCHIVE FAILED **', '');
    expect(explained).toContain('** ARCHIVE FAILED **');
    expect(explained).toContain('--verbose');
  });

  it('says so when xcodebuild printed nothing at all', () => {
    expect(explainBuildFailure('', '')).toContain('printed nothing');
  });
});
