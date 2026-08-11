/**
 * The override is realised by rewriting a file the build already includes, so
 * the tests that matter are about the file: one assignment, never two, and every
 * other byte left where it was.
 */
import { describe, expect, it } from 'vitest';
import { projectFrom } from '../src/project.js';
import {
  applyOverride,
  currentOverride,
  escapeValue,
  readSetting,
  requireOverrides,
  resolveOverrideValue,
  setSetting,
  unescapeValue,
} from '../src/xcconfig.js';
import { fakeBoundary } from './helpers/fake-boundary.js';
import { testConfig } from './helpers/config.js';

const PROD = 'https://api.example.com';

const config = testConfig({
  xcconfigOverrides: {
    file: 'ios/Acme/config/Local.xcconfig',
    key: 'API_BASE_URL',
    presets: { prod: PROD, staging: 'https://staging.example.com' },
  },
});

const project = projectFrom('/w/jetbridge.config.json', config);
const configPath = '/w/ios/Acme/config/Local.xcconfig';

const bare = testConfig();

describe('requireOverrides', () => {
  it('names the config key to add when there is no override configured', () => {
    expect(() => requireOverrides(bare)).toThrow(/Add `xcconfigOverrides` to the config/);
  });

  it('returns the configured block when there is one', () => {
    expect(requireOverrides(config).key).toBe('API_BASE_URL');
  });
});

describe('resolveOverrideValue', () => {
  it('is undefined when neither a value nor a preset was given', () => {
    expect(resolveOverrideValue({}, config)).toBeUndefined();
  });

  it('takes a raw value', () => {
    expect(resolveOverrideValue({ value: 'http://192.168.1.4:4000' }, config)).toBe(
      'http://192.168.1.4:4000',
    );
  });

  it('trims a raw value', () => {
    expect(resolveOverrideValue({ value: '  https://api.example.com  ' }, config)).toBe(PROD);
  });

  it('resolves a named preset', () => {
    expect(resolveOverrideValue({ preset: 'prod' }, config)).toBe(PROD);
  });

  it('accepts a value and a preset that agree', () => {
    expect(resolveOverrideValue({ preset: 'prod', value: PROD }, config)).toBe(PROD);
  });

  it('refuses a value and a preset that disagree', () => {
    expect(() =>
      resolveOverrideValue({ preset: 'prod', value: 'https://other.example.com' }, config),
    ).toThrow(/disagree[\s\S]*Pass just one/);
  });

  it('lists the presets that do exist when the named one does not', () => {
    expect(() => resolveOverrideValue({ preset: 'nope' }, config)).toThrow(
      /no "nope" preset for API_BASE_URL[\s\S]*prod, staging/,
    );
  });

  it('says so when no preset is configured at all', () => {
    const noPresets = testConfig({
      xcconfigOverrides: { file: 'ios/Local.xcconfig', key: 'API_BASE_URL' },
    });
    expect(() => resolveOverrideValue({ preset: 'prod' }, noPresets)).toThrow(
      /\(none configured\)/,
    );
  });

  it('refuses a bare host, which never resolves', () => {
    expect(() => resolveOverrideValue({ value: 'api.example.com' }, config)).toThrow(
      /has no scheme — write it as https:\/\/api\.example\.com/,
    );
  });

  it('refuses a bare host with a port', () => {
    expect(() => resolveOverrideValue({ value: '192.168.1.4:4000' }, config)).toThrow(
      /has no scheme/,
    );
  });

  it('refuses a bare localhost', () => {
    expect(() => resolveOverrideValue({ value: 'localhost:4000' }, config)).toThrow(
      /has no scheme/,
    );
  });

  it('accepts a scheme other than http', () => {
    expect(resolveOverrideValue({ value: 'wss://api.example.com' }, config)).toBe(
      'wss://api.example.com',
    );
  });

  it('leaves a value that is not a URL alone', () => {
    // The setting need not be a URL — a plain flag value must not be second-guessed.
    expect(resolveOverrideValue({ value: 'YES' }, config)).toBe('YES');
  });

  it('refuses before anything else when there is no override configured', () => {
    expect(() => resolveOverrideValue({ value: PROD }, bare)).toThrow(/xcconfigOverrides/);
  });
});

describe('escaping', () => {
  it('breaks up // so xcconfig does not read it as a comment', () => {
    expect(escapeValue(PROD)).toBe('https:/$()/api.example.com');
  });

  it('round-trips', () => {
    expect(unescapeValue(escapeValue(PROD))).toBe(PROD);
  });

  it('leaves a value with no // untouched', () => {
    expect(escapeValue('YES')).toBe('YES');
  });
});

describe('setSetting', () => {
  it('writes the assignment into an empty file', () => {
    expect(setSetting('', 'API_BASE_URL', PROD)).toBe(
      'API_BASE_URL = https:/$()/api.example.com\n',
    );
  });

  it('replaces an existing assignment rather than adding a second one', () => {
    const before = 'API_BASE_URL = https:/$()/old.example.com\n';
    const after = setSetting(before, 'API_BASE_URL', PROD);
    expect(after.split('\n').filter((l) => l.startsWith('API_BASE_URL'))).toHaveLength(1);
    expect(after).toBe('API_BASE_URL = https:/$()/api.example.com\n');
  });

  it('collapses a file that already carries the key twice', () => {
    // An xcconfig silently takes the last assignment, so a duplicate is a trap.
    const before = 'API_BASE_URL = a\nOTHER = 1\nAPI_BASE_URL = b\n';
    expect(setSetting(before, 'API_BASE_URL', 'YES')).toBe('API_BASE_URL = YES\nOTHER = 1\n');
  });

  it('preserves comments and unrelated keys byte for byte', () => {
    const before =
      '// AUTO-GENERATED — do not commit.\n' +
      '\n' +
      'OTHER_SETTING = keep me\n' +
      'API_BASE_URL = https:/$()/old.example.com\n' +
      '#include? "More.xcconfig"\n';
    expect(setSetting(before, 'API_BASE_URL', PROD)).toBe(
      '// AUTO-GENERATED — do not commit.\n' +
        '\n' +
        'OTHER_SETTING = keep me\n' +
        'API_BASE_URL = https:/$()/api.example.com\n' +
        '#include? "More.xcconfig"\n',
    );
  });

  it('appends when the key is not there yet', () => {
    expect(setSetting('OTHER = 1\n', 'API_BASE_URL', 'YES')).toBe(
      'OTHER = 1\nAPI_BASE_URL = YES\n',
    );
  });

  it('does not mistake a key that merely starts the same', () => {
    const before = 'API_BASE_URL_EXTRA = keep\n';
    expect(setSetting(before, 'API_BASE_URL', 'YES')).toBe(
      'API_BASE_URL_EXTRA = keep\nAPI_BASE_URL = YES\n',
    );
  });

  it('matches an indented assignment', () => {
    expect(setSetting('  API_BASE_URL = old\n', 'API_BASE_URL', 'YES')).toBe(
      'API_BASE_URL = YES\n',
    );
  });

  it('is idempotent — twice equals once', () => {
    const once = setSetting('OTHER = 1\n', 'API_BASE_URL', PROD);
    expect(setSetting(once, 'API_BASE_URL', PROD)).toBe(once);
  });

  it('ends the file with exactly one newline', () => {
    expect(setSetting('OTHER = 1', 'API_BASE_URL', 'YES')).toMatch(/[^\n]\n$/);
  });
});

describe('readSetting', () => {
  it('reads the value back, unescaped', () => {
    expect(readSetting('API_BASE_URL = https:/$()/api.example.com\n', 'API_BASE_URL')).toBe(PROD);
  });

  it('is undefined when the key is absent', () => {
    expect(readSetting('OTHER = 1\n', 'API_BASE_URL')).toBeUndefined();
  });

  it('reports the assignment the build would actually see', () => {
    expect(readSetting('API_BASE_URL = a\nAPI_BASE_URL = b\n', 'API_BASE_URL')).toBe('b');
  });
});

describe('applyOverride', () => {
  it('creates the file when it is not there yet', () => {
    const boundary = fakeBoundary();
    const applied = applyOverride(boundary, project, { preset: 'prod' })!;
    expect(applied).toEqual({ path: configPath, key: 'API_BASE_URL', value: PROD });
    expect(boundary.fs.read(configPath)).toBe('API_BASE_URL = https:/$()/api.example.com\n');
  });

  it('writes into the configured file, relative to the project root', () => {
    const boundary = fakeBoundary();
    applyOverride(boundary, project, { preset: 'prod' });
    expect(boundary.writes).toEqual([configPath]);
  });

  it('leaves the rest of an existing file alone', () => {
    const boundary = fakeBoundary({
      files: {
        [configPath]: '// generated\nOTHER = 1\nAPI_BASE_URL = https:/$()/old.example.com\n',
      },
    });
    applyOverride(boundary, project, { preset: 'staging' });
    expect(boundary.fs.read(configPath)).toBe(
      '// generated\nOTHER = 1\nAPI_BASE_URL = https:/$()/staging.example.com\n',
    );
  });

  it('does nothing when no override was asked for', () => {
    const boundary = fakeBoundary();
    expect(applyOverride(boundary, project, {})).toBeNull();
    expect(boundary.writes).toEqual([]);
  });

  it('is idempotent', () => {
    const boundary = fakeBoundary();
    applyOverride(boundary, project, { preset: 'prod' });
    const once = boundary.fs.read(configPath);
    applyOverride(boundary, project, { preset: 'prod' });
    expect(boundary.fs.read(configPath)).toBe(once);
  });

  it('says which value went where', () => {
    const boundary = fakeBoundary();
    const messages: string[] = [];
    boundary.log.info = (m) => messages.push(m);
    applyOverride(boundary, project, { preset: 'prod' });
    expect(messages.join('\n')).toBe(
      `API_BASE_URL → ${PROD} (written to ios/Acme/config/Local.xcconfig)`,
    );
  });
});

describe('currentOverride', () => {
  it('reports what the build will use', () => {
    const boundary = fakeBoundary({
      files: { [configPath]: 'API_BASE_URL = https:/$()/api.example.com\n' },
    });
    expect(currentOverride(boundary, project)).toBe(PROD);
  });

  it('is undefined when the file does not exist yet', () => {
    expect(currentOverride(fakeBoundary(), project)).toBeUndefined();
  });

  it('is undefined when the file exists but carries no override', () => {
    const boundary = fakeBoundary({ files: { [configPath]: '// nothing here\n' } });
    expect(currentOverride(boundary, project)).toBeUndefined();
  });

  it('reads back exactly what was written', () => {
    const boundary = fakeBoundary();
    applyOverride(boundary, project, { value: 'http://192.168.1.4:4000' });
    expect(currentOverride(boundary, project)).toBe('http://192.168.1.4:4000');
  });

  it('refuses when there is no override configured', () => {
    expect(() =>
      currentOverride(fakeBoundary(), projectFrom('/w/jetbridge.config.json', bare)),
    ).toThrow(/xcconfigOverrides/);
  });
});
