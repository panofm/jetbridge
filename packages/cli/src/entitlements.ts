/**
 * The variant entitlement swap.
 *
 * A variant build differs from the committed project in exactly one respect: it
 * signs against reduced entitlements, because capabilities like app groups and
 * Sign in with Apple cannot be granted through the public App Store Connect
 * API. In the project file that is the `CODE_SIGN_ENTITLEMENTS` assignments,
 * and nothing else.
 *
 * So those lines are patched in place rather than the project being
 * regenerated. A regeneration rewrites the whole project; xcodebuild
 * fingerprints it by content, sees a change, and rebuilds — turning every
 * incremental install into a slow one. The targeted patch touches only the
 * lines the build already expects to differ.
 */
import { relative } from 'node:path';
import type { Boundary } from './boundary.js';
import { fail, type Project } from './project.js';
import { targetEntitlements } from './xcodeproject.js';

/**
 * Project generators quote a path containing anything a bare token cannot hold
 * (a hyphen, typically). Matching that spelling exactly is what keeps the
 * patched file byte-identical to a regenerated one — and byte-identity is what
 * keeps the build incremental.
 */
export const codeSignLine = (path: string): string =>
  `CODE_SIGN_ENTITLEMENTS = ${/[^A-Za-z0-9/._]/.test(path) ? `"${path}"` : path};`;

/**
 * Every target that has a shipping entitlements file AND a variant one to swap
 * in, as the two paths the project file itself spells.
 *
 * TWO BASES MEET HERE, and keeping them straight is the whole job.
 * `CODE_SIGN_ENTITLEMENTS` is relative to the XCODE PROJECT DIRECTORY
 * (`Acme/Acme.entitlements`), and only a byte-identical match rewrites the
 * line. A config path is relative to the PROJECT ROOT, which is what the schema
 * documents and what `relativePath` enforces.
 *
 * So `from` is taken verbatim from the pbxproj — no normalising, or it stops
 * matching — and `to` is the config's root-relative path re-expressed against
 * the same directory. Before this, the config supplied both halves, and a
 * config written the way the schema documents produced a `from` that matched
 * nothing: a loud failure, but one whose message blamed a stale project rather
 * than the spelling.
 */
export function swappableTargets(
  boundary: Boundary,
  project: Project,
  configuration: string,
): Array<{ target: string; from: string; to: string }> {
  const shipping = targetEntitlements(boundary, project, configuration);
  const iosDir = project.iosPath();
  return project.config.variant.targets
    .filter((target) => target.variantEntitlements && shipping[target.name])
    .map((target) => ({
      target: target.name,
      from: shipping[target.name]!.raw,
      to: relative(iosDir, project.path(target.variantEntitlements!)),
    }));
}

/** Config-only: is a swap even asked for? Cheap enough to run before any read. */
export const hasVariantEntitlements = (project: Project): boolean =>
  project.config.variant.targets.some((target) => target.variantEntitlements);

/**
 * A declared variant entitlements file has to be where the config says it is.
 *
 * Checked BEFORE the build, and before provisioning mints anything at Apple,
 * because the alternative is discovering it mid-flow with a profile already
 * registered. The message quotes the ABSOLUTE path it looked at: the one
 * mistake this catches is a path spelled against the wrong directory, and
 * seeing where it actually looked is what makes that obvious.
 */
export function assertVariantEntitlements(boundary: Boundary, project: Project): void {
  const missing = project.config.variant.targets
    .filter((target) => target.variantEntitlements)
    .map((target) => ({ name: target.name, path: project.path(target.variantEntitlements!) }))
    .filter((entry) => !boundary.fs.exists(entry.path));
  if (missing.length === 0) return;
  fail(
    `variantEntitlements was declared for ${missing.map((entry) => entry.name).join(', ')}, ` +
      'but there is no file there:\n' +
      missing.map((entry) => `  ${entry.path}`).join('\n') +
      '\n  The path is relative to this config file, not to the Xcode project directory —\n' +
      `  so a target whose CODE_SIGN_ENTITLEMENTS reads "Acme/Acme.entitlements" wants\n` +
      `  "${project.config.project.iosDir}/Acme/Acme-variant.entitlements" here.`,
  );
}

export const pbxprojPath = (project: Project): string =>
  project.iosPath(project.xcodeprojName() ?? '', 'project.pbxproj');

export function applySwap(boundary: Boundary, project: Project, configuration: string): void {
  const path = pbxprojPath(project);
  const swaps = swappableTargets(boundary, project, configuration);

  // A target the config gives a variant file but the project assigns nothing to
  // has NOTHING TO SWAP FROM, and dropping it quietly is the dangerous outcome:
  // it would build with full entitlements and sign against a variant profile
  // that does not carry them, which fails at install with no useful message.
  const swapped = new Set(swaps.map((swap) => swap.target));
  const missing = project.config.variant.targets
    .filter((target) => target.variantEntitlements && !swapped.has(target.name))
    .map((target) => target.name);
  if (missing.length > 0) {
    fail(
      `${missing.join(', ')} declare variantEntitlements, but ${path} assigns them no ` +
        'CODE_SIGN_ENTITLEMENTS to swap out.\n' +
        '  Point the target at its shipping entitlements file in Xcode, or drop ' +
        'variantEntitlements for it.',
    );
  }

  const before = boundary.fs.read(path);
  let after = before;
  for (const swap of swaps) {
    after = after.replaceAll(codeSignLine(swap.from), codeSignLine(swap.to));
  }
  const applied = swaps.every((swap) => after.includes(codeSignLine(swap.to)));
  if (after === before || !applied) {
    fail(
      'the entitlement swap matched no CODE_SIGN_ENTITLEMENTS in the project file.\n' +
        `  Nothing in ${path} assigns one of: ${swaps.map((swap) => swap.from).join(', ') || '(none)'}\n` +
        '  Regenerate the project if it is stale.',
    );
  }
  boundary.fs.write(path, after);
}

/**
 * A swap stranded by a killed run. The project file is tracked, so a later
 * `git add -A` would quietly commit the reduced entitlements — and the next
 * build would sign against them without anyone asking for a variant.
 *
 * Only an assignment counts. A clean project already mentions the variant
 * entitlements file in its file references, because the file exists on disk.
 */
export function findStrandedSwap(
  boundary: Boundary,
  project: Project,
  configuration: string,
): string | null {
  const path = pbxprojPath(project);
  if (!boundary.fs.exists(path)) return null;
  const contents = boundary.fs.read(path);
  const stranded = swappableTargets(boundary, project, configuration).find((swap) =>
    contents.includes(codeSignLine(swap.to)),
  );
  return stranded ? path : null;
}

/**
 * Run `body` with the swap applied, and restore the original bytes whatever
 * happens.
 *
 * The restore copies the pre-swap bytes back rather than reverting through git,
 * which would also discard unrelated uncommitted edits. `finally` covers a
 * normal exit or a throw; the signal handlers cover the rest.
 *
 * SIGTERM and SIGHUP matter as much as SIGINT here: their default action is to
 * die without unwinding, so a `kill` from another shell or an editor's stop
 * button would otherwise strand the reduced entitlements in the working tree.
 * SIGKILL cannot be caught — that is what the stranded check is for.
 *
 * `body` must not block the event loop, or no handler can run while it does.
 * The restore itself stays synchronous: it has to finish inside the handler,
 * before the process exits.
 *
 * A no-op without a variant slug, and without a target asking for one: a plain
 * build keeps full entitlements. Anything past that point is checked properly —
 * a target that asks for a swap and cannot have one is an error, not a skip.
 */
const FATAL_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** 128 + signal number, the conventional exit code for a signalled death. */
const SIGNAL_EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

export async function withEntitlementSwap<T>(
  boundary: Boundary,
  project: Project,
  options: { suffix: string; backupPath: string; configuration: string },
  body: () => Promise<T>,
): Promise<T> {
  // Config-only, so a plain build never reads the project file to learn it has
  // nothing to do.
  if (!options.suffix || !hasVariantEntitlements(project)) return body();

  const stranded = findStrandedSwap(boundary, project, options.configuration);
  if (stranded) {
    fail(
      `${stranded} still carries a variant entitlement swap from an interrupted run.\n` +
        `  Restore it first (\`git checkout -- ${stranded}\`), then re-run.`,
    );
  }

  const path = pbxprojPath(project);
  let swapped = false;
  const restore = (): void => {
    if (!swapped) return;
    swapped = false;
    boundary.fs.write(path, boundary.fs.read(options.backupPath));
  };

  const handlers = FATAL_SIGNALS.map(
    (signal) =>
      [
        signal,
        () => {
          boundary.log.warn(`${signal} — restoring the project file before exit`);
          restore();
          process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
        },
      ] as const,
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);

  try {
    boundary.fs.write(options.backupPath, boundary.fs.read(path));
    // A step of its own rather than a bare line between two: the swap is a real
    // edit to the working tree, and it belongs in the run's own column.
    await boundary.report.run('entitlements', 'patched entitlements', async () => {
      applySwap(boundary, project, options.configuration);
      swapped = true;
    });
    return await body();
  } finally {
    restore();
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  }
}
