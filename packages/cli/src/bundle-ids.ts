/**
 * Which bundle id each target owns, read from the project rather than restated.
 *
 * An extension's id in the pbxproj is literally the app's id plus one segment —
 * `io.acme.app.dev.uploadwidget` — so the segment is not a choice anybody makes
 * twice. It is derived here, and a project that disagrees with itself is named
 * rather than guessed at.
 *
 * This module is deliberately STRICTER than its sibling `xcodeproject.ts`,
 * which degrades to "no facts" so that an unreadable project never refuses a
 * build that would have worked. The trade is the other way round here: with an
 * extension in play, failing to read the project would silently treat the
 * extension as a second app, register the wrong bundle id, and mint a profile
 * that signs and then refuses to install. A refused build is cheaper.
 */
import type { Boundary } from './boundary.js';
import type { TargetConfig } from './config.js';
import { fail, type Project } from './project.js';
import { projectFacts } from './xcodeproject.js';

/** A configured target plus the bundle-id segment the project gives it. */
export interface ResolvedTarget extends TargetConfig {
  /** Absent for the app itself, which owns the base id. */
  bundleIdSuffix?: string;
}

/**
 * Every configured target's `PRODUCT_BUNDLE_IDENTIFIER`, from ONE build
 * configuration.
 *
 * One configuration, never the best value from each: `Debug` and `Release` are
 * allowed to name different ids, and pairing an app's Debug id with an
 * extension's Release id produces a mismatch the project does not actually
 * have. The first configuration that names every target wins.
 *
 * Which one it is does not matter, and that is why no configuration is passed
 * in — unlike `targetEntitlements`, which reads the one the build will use. The
 * value read here is not the id but the SEGMENT under it, and a project that
 * renames an extension between Debug and Release has renamed the app to match:
 * the container relationship is what iOS enforces, in every configuration.
 */
function bundleIdsFrom(
  boundary: Boundary,
  project: Project,
  targets: TargetConfig[],
): Record<string, string> {
  const facts = projectFacts(boundary, project);
  if (!facts) {
    fail(
      'could not read the Xcode project, and it is the only thing that says which bundle id ' +
        'each target owns.\n' +
        '  Check project.iosDir and project.xcodeproj in the config.',
    );
  }

  const missing = targets.filter((target) => !facts.targets.some((t) => t.name === target.name));
  if (missing.length > 0) {
    fail(
      `the project has no target named ${missing.map((t) => `"${t.name}"`).join(' or ')}.\n` +
        `  It defines: ${facts.targets.map((t) => t.name).join(', ')}`,
    );
  }

  const order = [...facts.projectConfigurations, ...facts.allConfigurations];
  for (const configuration of order) {
    const found: Record<string, string> = {};
    for (const target of targets) {
      const pbxTarget = facts.targets.find((t) => t.name === target.name)!;
      const id = pbxTarget.settings[configuration]?.PRODUCT_BUNDLE_IDENTIFIER;
      // A setting reference resolves to an id only xcodebuild can compute.
      if (id && !id.includes('$(') && !id.includes('${')) found[target.name] = id;
    }
    if (Object.keys(found).length === targets.length) return found;
  }
  fail(
    'no build configuration in the project gives every target a PRODUCT_BUNDLE_IDENTIFIER, ' +
      'so the extension bundle ids cannot be derived.',
  );
}

/**
 * The app target is the one whose id every other id extends. That is what
 * "ships inside it" means on disk, and it does not depend on target order,
 * product type, or a name anybody has to keep in step.
 */
function appTargetName(bundleIds: Record<string, string>): string {
  const entries = Object.entries(bundleIds);
  const candidates = entries.filter(([, id]) =>
    entries.every(([, other]) => other === id || other.startsWith(`${id}.`)),
  );
  if (candidates.length === 1) return candidates[0]![0];
  if (candidates.length === 0) {
    fail(
      'no target owns the bundle id the others extend, so none of them is the app:\n' +
        entries.map(([name, id]) => `  ${name}: ${id}`).join('\n'),
    );
  }
  fail(
    'two targets share a bundle id, so which one is the app is ambiguous:\n' +
      candidates.map(([name, id]) => `  ${name}: ${id}`).join('\n'),
  );
}

/**
 * The configured targets, each carrying the bundle-id segment the project gives
 * it. Order is the config's, which is the order provisioning reports in.
 *
 * A single target IS the app, so nothing is read: an app with no extension must
 * build even where the project file cannot be parsed.
 */
export function resolveTargets(boundary: Boundary, project: Project): ResolvedTarget[] {
  const targets = project.config.variant.targets;
  if (targets.length <= 1) return targets;

  const bundleIds = bundleIdsFrom(boundary, project, targets);
  const app = appTargetName(bundleIds);
  const appId = bundleIds[app]!;

  return targets.map((target) => {
    if (target.name === app) return target;
    const id = bundleIds[target.name]!;
    if (!id.startsWith(`${appId}.`)) {
      fail(
        `${target.name}'s bundle id is not inside the app's, so it is not an extension of it:\n` +
          `  ${app}: ${appId}\n` +
          `  ${target.name}: ${id}`,
      );
    }
    return { ...target, bundleIdSuffix: id.slice(appId.length + 1) };
  });
}
