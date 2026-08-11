/**
 * Where the project is, and where everything resolves from.
 *
 * The tool this was extracted from had a `REPO_ROOT` constant, which means
 * nothing in a published CLI. The root is discovered instead: walk up from the
 * working directory until a config file appears. Every other path in jetbridge
 * is resolved against it, so getting this wrong is getting everything wrong.
 */
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Boundary } from './boundary.js';
import { CONFIG_FILENAMES, formatConfigErrors, parseConfig, type Config } from './config.js';

/** An expected failure with a written explanation — printed as one line, no stack. */
export class JetbridgeError extends Error {
  override readonly name = 'JetbridgeError';
}

/** A function declaration, not an arrow: TypeScript only narrows control flow through one. */
export function fail(message: string): never {
  throw new JetbridgeError(message);
}

export interface Project {
  /** Directory holding the config file. Everything relative resolves from here. */
  root: string;
  configPath: string;
  config: Config;
  /** Absolute path to a project-relative one. */
  path(...segments: string[]): string;
  /** Absolute path inside the Xcode project directory. */
  iosPath(...segments: string[]): string;
  /** The `-project` or `-workspace` argument pair for xcodebuild. */
  xcodebuildTarget(): [flag: string, path: string];
}

/** The nearest config file at or above `from`, or null. */
export function findConfigFile(boundary: Boundary, from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(dir, name);
      if (boundary.fs.exists(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function projectFrom(configPath: string, config: Config): Project {
  const root = dirname(configPath);
  const path = (...segments: string[]): string => resolve(root, ...segments);
  const iosPath = (...segments: string[]): string =>
    resolve(root, config.project.iosDir, ...segments);
  return {
    root,
    configPath,
    config,
    path,
    iosPath,
    xcodebuildTarget: () =>
      config.project.xcworkspace
        ? ['-workspace', iosPath(config.project.xcworkspace)]
        : ['-project', iosPath(config.project.xcodeproj!)],
  };
}

export interface LoadOptions {
  /** Start the upward walk here instead of the working directory. */
  from?: string;
  /** Use exactly this file, e.g. from `--config-file`. */
  configPath?: string;
}

export function loadProject(boundary: Boundary, options: LoadOptions = {}): Project {
  const explicit = options.configPath;
  const configPath = explicit
    ? isAbsolute(explicit)
      ? explicit
      : resolve(boundary.cwd(), explicit)
    : findConfigFile(boundary, options.from ?? boundary.cwd());

  if (!configPath) {
    fail(
      `no ${CONFIG_FILENAMES[0]} found in this directory or any parent.\n` +
        '  Run `jetbridge init` to create one.',
    );
  }
  if (!boundary.fs.exists(configPath)) {
    fail(`config file not found: ${configPath}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(boundary.fs.read(configPath));
  } catch (e) {
    return fail(`${configPath} is not valid JSON — ${(e as Error).message}`);
  }

  const result = parseConfig(raw);
  if (!result.ok) {
    return fail(
      `${configPath} is not a valid jetbridge config:\n${formatConfigErrors(result.errors)}`,
    );
  }
  return projectFrom(configPath, result.config);
}
