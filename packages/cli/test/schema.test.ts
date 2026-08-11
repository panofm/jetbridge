/**
 * `schema/v1.json` is what editors autocomplete a project's config against, and
 * it ships as the package's `./schema` export. It is generated from the same zod
 * definition the validator uses — so the only way it can be wrong is by being
 * stale. This test is what makes that a failing suite rather than a shipped file
 * that suggests fields the validator rejects.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_VERSION, jsonSchema } from '../src/config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCHEMA_PATH = join(ROOT, 'schema', 'v1.json');

describe('schema/v1.json', () => {
  it('exists — package.json publishes it as the ./schema export', () => {
    expect(existsSync(SCHEMA_PATH)).toBe(true);
  });

  it('matches what src/config.ts generates', () => {
    expect(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))).toEqual(jsonSchema());
  });

  it('is byte-identical to a fresh generation', () => {
    // Runs the real script, so `npm run check:schema` and this test can never
    // disagree about what "up to date" means.
    expect(() =>
      execFileSync('node', [join(ROOT, 'scripts', 'generate-schema.mjs'), '--check'], {
        cwd: ROOT,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('is formatted the way the generator writes it', () => {
    const text = readFileSync(SCHEMA_PATH, 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.split('\n')[1]).toMatch(/^ {2}"/);
  });

  it('pins the config version the validator accepts', () => {
    const schema = jsonSchema() as { properties: { configVersion: { const: number } } };
    expect(schema.properties.configVersion.const).toBe(CONFIG_VERSION);
  });

  it('requires the fields a config cannot be written without', () => {
    const schema = jsonSchema() as { required: string[] };
    expect(schema.required).toContain('configVersion');
    expect(schema.required).toContain('project');
    expect(schema.required).toContain('variant');
  });
});
