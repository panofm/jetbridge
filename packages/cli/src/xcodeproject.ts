/**
 * What the Xcode project says, read at build time.
 *
 * Two facts a build needs are already stated in `project.pbxproj`, and a config
 * that repeats them is a copy that goes stale: the build configurations the
 * project defines, and the entitlements file each target signs against. Both
 * are read from the project itself instead.
 *
 * The parser is `detect.ts`'s — the wizard and the build read the same file the
 * same way, and there is exactly one pbxproj parser in this package. What
 * differs is the shape: the wizard wants sourced suggestions to show a person,
 * a build wants the value or nothing.
 *
 * Nothing here is fatal. An unfamiliar project file yields no facts, and every
 * caller degrades to letting xcodebuild be the judge — a build that would have
 * worked must never be refused because this file could not be read.
 */
import { relative, resolve } from 'node:path';
import type { Boundary } from './boundary.js';
import { parsePbxproj, settingValue, type PbxprojFacts } from './detect.js';
import { fail, type Project } from './project.js';

/**
 * A target's entitlements file, in both spellings — one read, one parse, and
 * neither caller normalising the other's.
 *
 * `raw` is what the project file literally holds, and it is what the
 * entitlement swap matches on: `CODE_SIGN_ENTITLEMENTS` is relative to the
 * Xcode project's own directory (`Acme/Acme.entitlements`), and only a
 * byte-identical match rewrites the line.
 *
 * `rootRelative` is the same file relative to the config, which is what a
 * caller opening the file needs.
 */
export interface TargetEntitlements {
  raw: string;
  rootRelative: string;
}

/** The parsed project, or null when there is nothing readable to parse. */
export function projectFacts(boundary: Boundary, project: Project): PbxprojFacts | null {
  const xcodeproj = project.xcodeprojName();
  if (!xcodeproj) return null;
  const path = project.iosPath(xcodeproj, 'project.pbxproj');
  if (!boundary.fs.exists(path)) return null;
  try {
    const facts = parsePbxproj(boundary.fs.read(path));
    return facts.targets.length === 0 && facts.projectConfigurations.length === 0 ? null : facts;
  } catch {
    return null;
  }
}

/**
 * The configurations `-configuration` accepts, or null when the project could
 * not be read. Null means "unknown", never "none" — the difference decides
 * whether a build is refused.
 */
export function projectConfigurations(boundary: Boundary, project: Project): string[] | null {
  const facts = projectFacts(boundary, project);
  if (!facts || facts.projectConfigurations.length === 0) return null;
  return facts.projectConfigurations;
}

/**
 * Refuse a configuration the project does not define, before anything slow runs.
 *
 * A false rejection is the expensive failure here — it blocks a build that
 * would have worked — so an unreadable project skips the check entirely and
 * xcodebuild gets to be the judge.
 */
export function assertConfiguration(
  boundary: Boundary,
  project: Project,
  configuration: string,
): void {
  const configurations = projectConfigurations(boundary, project);
  if (!configurations || configurations.includes(configuration)) return;
  fail(
    `"${configuration}" is not one of this project's build configurations ` +
      `(${configurations.join(', ')})`,
  );
}

/**
 * The entitlements each configured target signs against, by target name.
 *
 * `configuration` decides which one is read, because `Debug` and `Release` are
 * allowed to name different files — the swap has to match the line the build
 * will actually use. Omit it where the answer is the same either way, and Debug
 * wins as the inner loop's. A target that declares none is absent from the map
 * rather than present and empty.
 */
export function targetEntitlements(
  boundary: Boundary,
  project: Project,
  configuration = 'Debug',
): Record<string, TargetEntitlements> {
  const facts = projectFacts(boundary, project);
  if (!facts) return {};
  const preferred = [
    configuration,
    ...facts.projectConfigurations.filter((name) => name !== configuration),
  ];
  const iosDir = project.iosPath();

  const found: Record<string, TargetEntitlements> = {};
  for (const target of project.config.variant.targets) {
    const pbxTarget = facts.targets.find((candidate) => candidate.name === target.name);
    if (!pbxTarget) continue;
    const raw = settingValue(pbxTarget.settings, 'CODE_SIGN_ENTITLEMENTS', preferred)?.value;
    // A build setting reference resolves to a path only xcodebuild can compute.
    if (!raw || raw.includes('$(') || raw.includes('${')) continue;
    found[target.name] = { raw, rootRelative: relative(project.root, resolve(iosDir, raw)) };
  }
  return found;
}
