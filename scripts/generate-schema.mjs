#!/usr/bin/env node
/**
 * `schema/v1.json` is published as the `./schema` export, and editors
 * autocomplete a project's config against it. It is generated from the same zod
 * definition the validator uses, so the two can never disagree — but only if it
 * is REGENERATED. A stale file is worse than none: it autocompletes fields the
 * validator has since rejected.
 *
 * `--check` fails when the checked-in file differs from what the code would
 * generate, so the drift is caught in CI rather than by a confused user.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const SCHEMA_PATH = join(ROOT, 'schema', 'v1.json');

/**
 * The definition lives in TypeScript and Node cannot import that directly. It is
 * transpiled with the compiler this repo already depends on, rather than adding
 * a build step or — far worse — a second copy of the schema that drifts.
 *
 * The output lands inside `node_modules` so `zod` resolves by the normal upward
 * walk, and is imported with a cache-busting query so a repeated run in one
 * process sees the current source.
 */
export async function generate() {
  const { default: ts } = await import('typescript');
  const source = readFileSync(join(ROOT, 'src', 'config.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
      verbatimModuleSyntax: true,
    },
  });

  const cacheDir = join(ROOT, 'node_modules', '.cache', 'jetbridge');
  mkdirSync(cacheDir, { recursive: true });
  const modulePath = join(cacheDir, 'config.generated.mjs');
  writeFileSync(modulePath, outputText);

  const { jsonSchema } = await import(`${pathToFileURL(modulePath).href}?v=${Date.now()}`);
  return jsonSchema();
}

/** Keys sorted at every level, so the file is a function of the schema alone. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

export const serialize = (schema) => `${JSON.stringify(sortKeys(schema), null, 2)}\n`;

const isMain =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const check = process.argv.includes('--check');
  const expected = serialize(await generate());

  if (!check) {
    mkdirSync(join(ROOT, 'schema'), { recursive: true });
    writeFileSync(SCHEMA_PATH, expected);
    console.error(`wrote schema/v1.json (${expected.length} bytes)`);
    process.exit(0);
  }

  const actual = existsSync(SCHEMA_PATH) ? readFileSync(SCHEMA_PATH, 'utf8') : null;
  if (actual === expected) {
    console.error('schema/v1.json is up to date');
    process.exit(0);
  }
  console.error(
    actual === null
      ? 'schema/v1.json is missing — the published `./schema` export points at nothing.'
      : 'schema/v1.json does not match src/config.ts.',
  );
  console.error('  Run `npm run schema` and commit the result.');
  process.exit(1);
}
