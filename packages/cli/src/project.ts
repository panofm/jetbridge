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
import { resolveXcodeproj, ungeneratedAdvice } from './project-layout.js';

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
  /**
   * The `.xcodeproj` name, resolved. Undefined only for a workspace build, or
   * for a generated project that XcodeGen has not produced yet — and it is
   * re-resolved on each miss, so it finds the file the moment generation makes
   * it. Never cache the answer across a generate step.
   */
  xcodeprojName(): string | undefined;
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

export function projectFrom(configPath: string, config: Config, boundary?: Boundary): Project {
  const root = dirname(configPath);
  const path = (...segments: string[]): string => resolve(root, ...segments);
  const iosPath = (...segments: string[]): string =>
    resolve(root, config.project.iosDir, ...segments);

  // Held rather than recomputed once it is known, but a MISS is never cached:
  // `generateProject` writes the `.xcodeproj` mid-run, and everything after it
  // has to see the file that did not exist when the config was read.
  let found = config.project.xcodeproj;
  const xcodeprojName = (): string | undefined => {
    if (found ?? !boundary) return found;
    found = resolveXcodeproj(boundary, iosPath(), config.project);
    return found;
  };

  return {
    root,
    configPath,
    config,
    path,
    iosPath,
    xcodeprojName,
    xcodebuildTarget: () => {
      if (config.project.xcworkspace) {
        return ['-workspace', iosPath(config.project.xcworkspace)];
      }
      const xcodeproj = xcodeprojName();
      if (!xcodeproj) {
        fail(
          `no .xcodeproj in ${iosPath()} — the project has not been generated.\n` +
            `  ${ungeneratedAdvice(iosPath())}`,
        );
      }
      return ['-project', iosPath(xcodeproj)];
    },
  };
}

/**
 * A project that can find its own `.xcodeproj`.
 *
 * The name is resolved once here so an unanswerable directory — several
 * projects, or none with nothing to explain it — is reported at load rather
 * than three steps into a run.
 */
export function projectAt(boundary: Boundary, configPath: string, config: Config): Project {
  resolveXcodeproj(boundary, resolve(dirname(configPath), config.project.iosDir), config.project);
  return projectFrom(configPath, config, boundary);
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
