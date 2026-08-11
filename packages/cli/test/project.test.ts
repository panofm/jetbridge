import { describe, expect, it } from 'vitest';
import { CONFIG_VERSION } from '../src/config.js';
import { JetbridgeError, findConfigFile, loadProject, projectFrom } from '../src/project.js';
import { fakeBoundary } from './helpers/fake-boundary.js';
import { testConfig } from './helpers/config.js';

const validConfig = JSON.stringify({
  configVersion: CONFIG_VERSION,
  project: {
    iosDir: 'ios',
    xcodeproj: 'Acme.xcodeproj',
    scheme: 'Acme',
    teamId: 'ABCDE12345',
    baseBundleId: 'io.acme.app.dev',
  },
  variant: { displayName: 'Acme Dev' },
});

describe('findConfigFile', () => {
  it('finds the config in the working directory', () => {
    const boundary = fakeBoundary({ cwd: '/w', files: { '/w/jetbridge.config.json': '{}' } });
    expect(findConfigFile(boundary, '/w')).toBe('/w/jetbridge.config.json');
  });

  it('walks up until it finds one', () => {
    const boundary = fakeBoundary({
      cwd: '/w',
      files: { '/w/jetbridge.config.json': '{}', '/w/a/b/c/keep': 'x' },
    });
    expect(findConfigFile(boundary, '/w/a/b/c')).toBe('/w/jetbridge.config.json');
  });

  it('prefers the nearest config to a further one', () => {
    const boundary = fakeBoundary({
      cwd: '/w',
      files: { '/w/jetbridge.config.json': '{}', '/w/app/jetbridge.config.json': '{}' },
    });
    expect(findConfigFile(boundary, '/w/app')).toBe('/w/app/jetbridge.config.json');
  });

  it('accepts the dotfile spelling', () => {
    const boundary = fakeBoundary({ cwd: '/w', files: { '/w/.jetbridge.json': '{}' } });
    expect(findConfigFile(boundary, '/w')).toBe('/w/.jetbridge.json');
  });

  it('returns null at the filesystem root rather than looping', () => {
    const boundary = fakeBoundary({ cwd: '/w', files: { '/w/other.json': '{}' } });
    expect(findConfigFile(boundary, '/w')).toBeNull();
  });
});

describe('loadProject', () => {
  const boundaryWith = (files: Record<string, string>, cwd = '/w') => fakeBoundary({ cwd, files });

  it('loads and validates the nearest config', () => {
    const project = loadProject(boundaryWith({ '/w/jetbridge.config.json': validConfig }));
    expect(project.root).toBe('/w');
    expect(project.config.project.scheme).toBe('Acme');
  });

  /** The config no longer names the project when the directory settles it. */
  const inferredConfig = JSON.stringify({
    configVersion: CONFIG_VERSION,
    project: {
      iosDir: 'ios',
      scheme: 'Acme',
      teamId: 'ABCDE12345',
      baseBundleId: 'io.acme.app.dev',
    },
    variant: { displayName: 'Acme Dev' },
  });

  it('infers the one .xcodeproj in the directory, so the config need not name it', () => {
    const project = loadProject(
      boundaryWith({
        '/w/jetbridge.config.json': inferredConfig,
        '/w/ios/Acme.xcodeproj/project.pbxproj': '// !$*UTF8*$!\n{}\n',
      }),
    );
    expect(project.xcodeprojName()).toBe('Acme.xcodeproj');
    expect(project.xcodebuildTarget()).toEqual(['-project', '/w/ios/Acme.xcodeproj']);
  });

  it('says which .xcodeproj to name when the directory holds several', () => {
    expect(() =>
      loadProject(
        boundaryWith({
          '/w/jetbridge.config.json': inferredConfig,
          '/w/ios/Acme.xcodeproj/project.pbxproj': 'x',
          '/w/ios/Legacy.xcodeproj/project.pbxproj': 'x',
        }),
      ),
    ).toThrow(/more than one \.xcodeproj[\s\S]*Acme\.xcodeproj[\s\S]*Legacy\.xcodeproj/);
  });

  /**
   * A generated project is not on disk until XcodeGen has run. Loading has to
   * succeed anyway — `bundles ls` never builds anything — and the complaint
   * belongs to the command that actually needs the file.
   */
  it('loads a generated project that has not been generated yet', () => {
    const project = loadProject(
      boundaryWith({
        '/w/jetbridge.config.json': inferredConfig,
        '/w/ios/project.yml': 'name: Acme\n',
      }),
    );
    expect(project.xcodeprojName()).toBeUndefined();
    expect(() => project.xcodebuildTarget()).toThrow(
      /the project has not been generated[\s\S]*Run `xcodegen generate` in \/w\/ios/,
    );
  });

  /**
   * The invariant the generate step rests on: `generateProject` writes the
   * `.xcodeproj` mid-run, and every step after it has to see a file that did
   * not exist when the config was read. Caching the miss is what would break
   * a fresh clone.
   */
  it('finds the project the moment generation writes it', () => {
    const boundary = boundaryWith({
      '/w/jetbridge.config.json': inferredConfig,
      '/w/ios/project.yml': 'name: Acme\n',
    });
    const project = loadProject(boundary);
    expect(project.xcodeprojName()).toBeUndefined();

    boundary.fs.write('/w/ios/Acme.xcodeproj/project.pbxproj', '// !$*UTF8*$!\n{}\n');
    expect(project.xcodeprojName()).toBe('Acme.xcodeproj');
    expect(project.xcodebuildTarget()).toEqual(['-project', '/w/ios/Acme.xcodeproj']);
  });

  it('has nothing to infer from and says where it looked', () => {
    expect(() => loadProject(boundaryWith({ '/w/jetbridge.config.json': inferredConfig }))).toThrow(
      /no \.xcodeproj was found in \/w\/ios/,
    );
  });

  it('names the file when the JSON is malformed', () => {
    expect(() => loadProject(boundaryWith({ '/w/jetbridge.config.json': '{ nope' }))).toThrow(
      /jetbridge\.config\.json is not valid JSON/,
    );
  });

  it('lists every validation problem when the config is wrong', () => {
    const bad = JSON.stringify({ configVersion: CONFIG_VERSION, project: {}, variant: {} });
    expect(() => loadProject(boundaryWith({ '/w/jetbridge.config.json': bad }))).toThrow(
      /not a valid jetbridge config/,
    );
  });

  it('points at init when there is no config anywhere', () => {
    expect(() => loadProject(boundaryWith({ '/w/readme.md': 'x' }))).toThrow(/jetbridge init/);
  });

  it('throws the expected-failure type, so the CLI prints one line', () => {
    expect(() => loadProject(boundaryWith({}))).toThrow(JetbridgeError);
  });

  it('honours an explicit relative config path', () => {
    const boundary = boundaryWith({ '/w/custom/here.json': validConfig });
    const project = loadProject(boundary, { configPath: 'custom/here.json' });
    expect(project.root).toBe('/w/custom');
  });

  it('honours an explicit absolute config path', () => {
    const boundary = boundaryWith({ '/elsewhere/here.json': validConfig });
    const project = loadProject(boundary, { configPath: '/elsewhere/here.json' });
    expect(project.root).toBe('/elsewhere');
  });

  it('reports an explicit path that does not exist', () => {
    expect(() => loadProject(boundaryWith({}), { configPath: '/nope.json' })).toThrow(
      /config file not found/,
    );
  });

  it('starts the walk from `from` when given', () => {
    const boundary = boundaryWith({ '/w/jetbridge.config.json': validConfig, '/w/deep/x': 'y' });
    expect(loadProject(boundary, { from: '/w/deep' }).root).toBe('/w');
  });
});

describe('path resolution', () => {
  const project = projectFrom('/w/jetbridge.config.json', testConfig());

  it('resolves project-relative paths from the config directory, not the cwd', () => {
    expect(project.path('scripts/thing.sh')).toBe('/w/scripts/thing.sh');
  });

  it('resolves iOS paths through iosDir', () => {
    expect(project.iosPath('Acme.xcodeproj')).toBe('/w/ios/Acme.xcodeproj');
  });

  it('builds the xcodebuild -project argument pair', () => {
    expect(project.xcodebuildTarget()).toEqual(['-project', '/w/ios/Acme.xcodeproj']);
  });

  it('prefers a workspace when the project declares one', () => {
    const workspace = projectFrom(
      '/w/jetbridge.config.json',
      testConfig({ project: { xcworkspace: 'Acme.xcworkspace' } }),
    );
    expect(workspace.xcodebuildTarget()).toEqual(['-workspace', '/w/ios/Acme.xcworkspace']);
  });

  it('treats iosDir "." as the project root', () => {
    const flat = projectFrom('/w/jetbridge.config.json', testConfig({ project: { iosDir: '.' } }));
    expect(flat.iosPath('Acme.xcodeproj')).toBe('/w/Acme.xcodeproj');
  });
});
