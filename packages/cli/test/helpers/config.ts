import { parseConfig, type Config } from '../../src/config.js';

/**
 * A minimal valid config. Tests that care about one field override just that
 * field, so a schema change surfaces here once instead of in every test.
 */
export function testConfig(overrides: Record<string, unknown> = {}): Config {
  const base = {
    configVersion: 1,
    project: {
      iosDir: 'ios',
      xcodeproj: 'Acme.xcodeproj',
      scheme: 'Acme',
      teamId: 'ABCDE12345',
      baseBundleId: 'io.acme.app.dev',
    },
    variant: { displayName: 'Acme Dev' },
  };
  const result = parseConfig(deepMerge(base, overrides));
  if (!result.ok) {
    throw new Error(
      `test config is invalid:\n${result.errors.map((e) => `${e.path}: ${e.message}`).join('\n')}`,
    );
  }
  return result.config;
}

export function deepMerge(
  base: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const existing = out[key];
    out[key] =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
        ? deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return out;
}
