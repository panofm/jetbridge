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
