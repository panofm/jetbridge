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
import { fail } from './errors.js';
import { resolveXcodeproj } from './project-layout.js';

// Re-exported so existing importers keep working; defined in errors.ts because
// the boundary needs to throw without importing the layer above it.
export { JetbridgeError, fail } from './errors.js';

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
    xcodebuildTarget: () => {
      if (config.project.xcworkspace) {
        return ['-workspace', iosPath(config.project.xcworkspace)];
      }
      if (!config.project.xcodeproj) {
        // Only reachable for a generated project that has not been generated:
        // resolution found a spec and no `.xcodeproj`, and deliberately let the
        // run get this far so the message could be this one.
        fail(
          `no .xcodeproj in ${iosPath()} yet.\n` +
            '  Generate the project first, then re-run — or set project.xcodegen to have ' +
            'jetbridge do it.',
        );
      }
      return ['-project', iosPath(config.project.xcodeproj)];
    },
  };
}

/** A project from a config that has not been through the edge resolution yet. */
export function projectAt(boundary: Boundary, configPath: string, config: Config): Project {
  return projectFrom(configPath, resolveProjectFile(boundary, dirname(configPath), config));
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
  return projectAt(boundary, configPath, result.config);
}

/**
 * Fill in the `.xcodeproj` the directory already names, once, here.
 *
 * Everything downstream reads `config.project.xcodeproj` — the pbxproj reader,
 * the entitlement swap, `xcodebuildTarget` — so inferring it at the edge keeps
 * all of them reading a single resolved value instead of each repeating the
 * search.
 */
export function resolveProjectFile(boundary: Boundary, root: string, config: Config): Config {
  const directory = resolve(root, config.project.iosDir);
  const xcodeproj = resolveXcodeproj(boundary, directory, config.project);
  if (xcodeproj === config.project.xcodeproj) return config;
  return { ...config, project: { ...config.project, ...(xcodeproj ? { xcodeproj } : {}) } };
}
