/**
 * Pointing a build at a different value for one build setting — typically the
 * API base URL — without editing a committed file.
 *
 * The value is written into a git-ignored xcconfig the project's build configs
 * already `#include?`, NOT passed as a command-line build setting. Two things
 * follow, and they are why it is done this way: a plain build from the Xcode GUI
 * picks the override up too, and the next rewrite of that file reverses it for
 * free.
 */
import type { Boundary } from './boundary.js';
import type { Config } from './config.js';
import { fail, type Project } from './project.js';

export type XcconfigOverrides = NonNullable<Config['xcconfigOverrides']>;

/** A raw value, a named preset, or neither. Both is fine when they agree. */
export interface OverrideRequest {
  value?: string;
  preset?: string;
}

export function requireOverrides(config: Config): XcconfigOverrides {
  const overrides = config.xcconfigOverrides;
  if (!overrides) {
    fail(
      'this project has no xcconfig override configured.\n' +
        '  Add `xcconfigOverrides` to the config — the git-ignored xcconfig file the build\n' +
        '  already `#include?`s, and the build setting to rewrite in it.',
    );
  }
  return overrides;
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * A value that reads as a host but carries no scheme. Rejected rather than
 * accepted: the app races each configured endpoint's health check, and a bare
 * host never resolves — silently, so the build looks fine and simply talks to
 * nothing.
 */
const LOOKS_LIKE_HOST = /^(?:localhost|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?::\d+)?(?:[/?#]|$)/;

/**
 * The value this run should write, or undefined when neither a value nor a
 * preset was given — in which case the file keeps whatever it already holds.
 */
export function resolveOverrideValue(request: OverrideRequest, config: Config): string | undefined {
  const overrides = requireOverrides(config);
  const explicit = request.value?.trim();

  if (explicit && !HAS_SCHEME.test(explicit) && LOOKS_LIKE_HOST.test(explicit)) {
    fail(
      `"${explicit}" has no scheme — write it as https://${explicit} (or http://).\n` +
        '  A bare host never resolves, and nothing says so at build time.',
    );
  }

  if (!request.preset) return explicit || undefined;

  const preset = overrides.presets[request.preset];
  if (preset === undefined) {
    const available = Object.keys(overrides.presets);
    fail(
      `there is no "${request.preset}" preset for ${overrides.key}.\n` +
        `  Available: ${available.join(', ') || '(none configured)'}`,
    );
  }
  // Naming both is only wrong when they disagree — `--prod` alongside the URL
  // it means is a person being explicit, not a mistake.
  if (explicit && explicit !== preset) {
    fail(
      `--${request.preset} and the value given disagree: --${request.preset} means "${preset}", ` +
        `but "${explicit}" was passed.\n  Pass just one.`,
    );
  }
  return preset;
}

/**
 * `//` opens a comment in an xcconfig, so a URL has to be broken up with an
 * empty `$()` substitution — which resolves back to `//` at build time. Without
 * this the value silently truncates to `https:`.
 */
export const escapeValue = (value: string): string => value.replaceAll('//', '/$()/');

export const unescapeValue = (value: string): string => value.replaceAll('$()', '');

const assignmentFor = (key: string): RegExp =>
  new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\s*=`);

/**
 * Rewrite one setting in an xcconfig's text, leaving every other line — comments
 * and unrelated keys alike — exactly as it was.
 *
 * An existing assignment is REPLACED, and any further assignment of the same key
 * is dropped: an xcconfig silently takes the last one, so appending a second
 * line works until somebody reorders the file.
 */
export function setSetting(contents: string, key: string, value: string): string {
  const line = `${key} = ${escapeValue(value)}`;
  const isAssignment = assignmentFor(key);

  const lines = contents.split('\n');
  const trailingBlank = lines.length > 0 && lines.at(-1) === '';
  if (trailingBlank) lines.pop();

  let written = false;
  const kept: string[] = [];
  for (const existing of lines) {
    if (!isAssignment.test(existing)) {
      kept.push(existing);
      continue;
    }
    if (!written) {
      kept.push(line);
      written = true;
    }
  }
  if (!written) {
    // An empty file splits to one empty line; appending to it would leave a
    // stray blank first line.
    if (kept.length === 1 && kept[0] === '') kept.pop();
    kept.push(line);
  }
  return `${kept.join('\n')}\n`;
}

/** The value the file currently carries for the key, or undefined. */
export function readSetting(contents: string, key: string): string | undefined {
  const isAssignment = assignmentFor(key);
  const match = contents.split('\n').filter((line) => isAssignment.test(line));
  // The last assignment is the one the build sees.
  const winner = match.at(-1);
  if (winner === undefined) return undefined;
  return unescapeValue(winner.slice(winner.indexOf('=') + 1).trim());
}

export interface AppliedOverride {
  /** Absolute path of the xcconfig that was written. */
  path: string;
  key: string;
  value: string;
}

/**
 * Write the override, creating the file when it is not there yet. Returns null
 * when nothing was asked for, so the caller can stay quiet.
 */
export function applyOverride(
  boundary: Boundary,
  project: Project,
  request: OverrideRequest,
): AppliedOverride | null {
  const value = resolveOverrideValue(request, project.config);
  if (value === undefined) return null;

  const overrides = requireOverrides(project.config);
  const path = project.path(overrides.file);
  const existing = boundary.fs.exists(path) ? boundary.fs.read(path) : '';
  boundary.fs.write(path, setSetting(existing, overrides.key, value));

  boundary.log.info(`${overrides.key} → ${value} (written to ${overrides.file})`);
  return { path, key: overrides.key, value };
}

/** What the build will currently use, for the CLI to print. Undefined when unset. */
export function currentOverride(boundary: Boundary, project: Project): string | undefined {
  const overrides = requireOverrides(project.config);
  const path = project.path(overrides.file);
  if (!boundary.fs.exists(path)) return undefined;
  return readSetting(boundary.fs.read(path), overrides.key);
}
