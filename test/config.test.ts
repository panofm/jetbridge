import { describe, expect, it } from 'vitest';
import {
  CONFIG_VERSION,
  formatConfigErrors,
  jsonSchema,
  labelPrefixFor,
  noiseWordsFor,
  parseConfig,
} from '../src/config.js';
import { testConfig } from './helpers/config.js';

const minimal = {
  configVersion: CONFIG_VERSION,
  project: {
    xcodeproj: 'Acme.xcodeproj',
    scheme: 'Acme',
    teamId: 'ABCDE12345',
    baseBundleId: 'io.acme.app.dev',
  },
  variant: { displayName: 'Acme Dev' },
};

const errorsFor = (value: unknown): string[] => {
  const result = parseConfig(value);
  if (result.ok) throw new Error('expected the config to be rejected');
  return result.errors.map((e) => `${e.path}: ${e.message}`);
};

describe('defaults', () => {
  it('fills every optional section', () => {
    const result = parseConfig(minimal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.project.iosDir).toBe('.');
    expect(result.config.project.xcodegen).toBe(false);
    expect(result.config.configurations).toEqual({
      available: ['Debug', 'Release'],
      wired: 'Debug',
      sim: 'Debug',
      archive: 'Release',
    });
    expect(result.config.variant.labelBudget).toBe(14);
    expect(result.config.variant.entitlements).toEqual([]);
    expect(result.config.credentials.ascKeyId).toBe('ASC_API_KEY_ID');
    expect(result.config.git.defaultBranch).toBe('main');
    expect(result.config.git.requireCleanDefaultBranch).toBe(false);
    expect(result.config.ota).toBeUndefined();
  });

  it('defaults the cabled build to a debuggable configuration', () => {
    // The inner loop wants the debug affordances; an archive goes to other
    // people and wants the optimised build.
    const { config } = parseConfig(minimal) as { config: ReturnType<typeof testConfig> };
    expect(config.configurations.wired).toBe('Debug');
    expect(config.configurations.archive).toBe('Release');
  });
});

describe('rejections', () => {
  it('requires a config version', () => {
    expect(errorsFor({ ...minimal, configVersion: undefined })).toContainEqual(
      expect.stringContaining('configVersion'),
    );
  });

  it('rejects a future config version', () => {
    expect(errorsFor({ ...minimal, configVersion: 99 })).toContainEqual(
      expect.stringContaining('configVersion'),
    );
  });

  it('requires either an xcodeproj or an xcworkspace', () => {
    const { xcodeproj: _drop, ...project } = minimal.project;
    expect(errorsFor({ ...minimal, project })).toContainEqual(
      'project.xcodeproj: set project.xcodeproj or project.xcworkspace',
    );
  });

  it('rejects a malformed team id', () => {
    for (const teamId of ['abcde12345', 'TOOSHORT', 'ABCDE123456']) {
      expect(errorsFor({ ...minimal, project: { ...minimal.project, teamId } })).toContainEqual(
        expect.stringContaining('team id'),
      );
    }
  });

  it('rejects a bundle id that is not reverse-DNS', () => {
    for (const baseBundleId of ['acme', 'io..acme', 'io.acme.']) {
      expect(
        errorsFor({ ...minimal, project: { ...minimal.project, baseBundleId } }),
      ).toContainEqual(expect.stringContaining('reverse-DNS'));
    }
  });

  it('rejects a build configuration that is not in the available list', () => {
    expect(
      errorsFor({
        ...minimal,
        configurations: { available: ['Debug', 'Release'], wired: 'Profile' },
      }),
    ).toContainEqual(
      'configurations.wired: "Profile" is not in configurations.available (Debug, Release)',
    );
  });

  it('accepts a custom configuration once it is declared', () => {
    const result = parseConfig({
      ...minimal,
      configurations: { available: ['Debug', 'Release', 'Profile'], wired: 'Profile' },
    });
    expect(result.ok).toBe(true);
  });

  it('requires a spec when xcodegen is on', () => {
    expect(
      errorsFor({ ...minimal, project: { ...minimal.project, xcodegen: true } }),
    ).toContainEqual(expect.stringContaining('project.projectYml'));
  });

  it('refuses an absolute path', () => {
    expect(
      errorsFor({ ...minimal, project: { ...minimal.project, iosDir: '/etc' } }),
    ).toContainEqual(expect.stringContaining('relative to the project root'));
  });

  it('refuses a path that escapes the project root', () => {
    expect(
      errorsFor({ ...minimal, project: { ...minimal.project, iosDir: '../elsewhere' } }),
    ).toContainEqual(expect.stringContaining('escape the project root'));
  });

  it('refuses an http OTA base URL, because iOS refuses to install from one', () => {
    expect(
      errorsFor({
        ...minimal,
        ota: { storage: { bucket: 'b', publicBaseUrl: 'http://builds.example.com' } },
      }),
    ).toContainEqual(expect.stringContaining('https://'));
  });

  it('accepts an https OTA base URL and fills the storage defaults', () => {
    const result = parseConfig({
      ...minimal,
      ota: { storage: { bucket: 'b', publicBaseUrl: 'https://builds.example.com' } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.ota?.storage.region).toBe('us-east-1');
    expect(result.config.ota?.storage.prefix).toBe('builds');
    expect(result.config.ota?.maxBuilds).toBe(60);
    expect(result.config.ota?.access).toBe('path');
    expect(result.config.ota?.exportMethod).toBe('ad-hoc');
  });

  it('rejects an unknown export method', () => {
    expect(
      errorsFor({
        ...minimal,
        ota: {
          storage: { bucket: 'b', publicBaseUrl: 'https://x.example.com' },
          exportMethod: 'app-store',
        },
      }),
    ).toContainEqual(expect.stringContaining('exportMethod'));
  });

  it('reports every problem at once rather than the first', () => {
    const errors = errorsFor({
      configVersion: CONFIG_VERSION,
      project: { xcodeproj: 'A.xcodeproj', scheme: 'A', teamId: 'bad', baseBundleId: 'nope' },
      variant: {},
    });
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('credentials never hold secrets', () => {
  it('stores variable names, and rejects anything that is not one', () => {
    const result = parseConfig({
      ...minimal,
      credentials: { ascKeyId: 'MY_KEY_ID' },
    });
    expect(result.ok).toBe(true);
    expect(
      errorsFor({ ...minimal, credentials: { ascKeyId: 'not a variable name' } }),
    ).toContainEqual(expect.stringContaining('plain identifier'));
  });
});

describe('noiseWordsFor', () => {
  it('derives commit types plus the bundle-id segments', () => {
    const words = noiseWordsFor(testConfig());
    for (const word of ['feat', 'fix', 'chore', 'io', 'acme', 'app', 'dev']) {
      expect(words.has(word)).toBe(true);
    }
    expect(words.has('wave')).toBe(false);
  });

  it('uses the configured list verbatim, lowercased', () => {
    const words = noiseWordsFor(testConfig({ variant: { noiseWords: ['Spike', 'WIP'] } }));
    expect([...words].sort()).toEqual(['spike', 'wip']);
  });
});

describe('labelPrefixFor', () => {
  it('takes the first word of the display name', () => {
    expect(labelPrefixFor(testConfig({ variant: { displayName: 'Acme Dev' } }))).toBe('Acme');
    expect(labelPrefixFor(testConfig({ variant: { displayName: 'Acme' } }))).toBe('Acme');
  });

  it('prefers an explicit prefix', () => {
    expect(labelPrefixFor(testConfig({ variant: { labelPrefix: 'AC' } }))).toBe('AC');
  });
});

describe('formatConfigErrors', () => {
  it('indents one problem per line', () => {
    expect(formatConfigErrors([{ path: 'a.b', message: 'nope' }])).toBe('  a.b: nope');
  });
});

describe('jsonSchema', () => {
  it('generates from the same definition the validator uses', () => {
    const schema = jsonSchema() as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(schema.properties)).toContain('project');
    expect(Object.keys(schema.properties)).toContain('ota');
    expect(schema.required).toContain('configVersion');
  });

  it('describes optional sections as optional', () => {
    const schema = jsonSchema() as { required?: string[] };
    expect(schema.required).not.toContain('ota');
    expect(schema.required).not.toContain('hooks');
  });
});
