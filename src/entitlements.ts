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
import type { Boundary } from './boundary.js';
import { fail, type Project } from './project.js';

/**
 * Project generators quote a path containing anything a bare token cannot hold
 * (a hyphen, typically). Matching that spelling exactly is what keeps the
 * patched file byte-identical to a regenerated one — and byte-identity is what
 * keeps the build incremental.
 */
export const codeSignLine = (path: string): string =>
  `CODE_SIGN_ENTITLEMENTS = ${/[^A-Za-z0-9/._]/.test(path) ? `"${path}"` : path};`;

/** Every target that declares both a shipping and a variant entitlements file. */
export function swappableTargets(project: Project): Array<{ from: string; to: string }> {
  return project.config.variant.targets
    .filter((target) => target.entitlements && target.variantEntitlements)
    .map((target) => ({ from: target.entitlements!, to: target.variantEntitlements! }));
}

export const pbxprojPath = (project: Project): string =>
  project.iosPath(project.config.project.xcodeproj ?? '', 'project.pbxproj');

export function applySwap(boundary: Boundary, project: Project): void {
  const path = pbxprojPath(project);
  const swaps = swappableTargets(project);
  const before = boundary.fs.read(path);
  let after = before;
  for (const swap of swaps) {
    after = after.replaceAll(codeSignLine(swap.from), codeSignLine(swap.to));
  }
  const applied = swaps.every((swap) => after.includes(codeSignLine(swap.to)));
  if (after === before || !applied) {
    fail(
      'the entitlement swap matched no CODE_SIGN_ENTITLEMENTS in the project file.\n' +
        '  Check that variant.targets[].entitlements matches the path the project spells,\n' +
        '  and regenerate the project if it is stale.',
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
export function findStrandedSwap(boundary: Boundary, project: Project): string | null {
  const path = pbxprojPath(project);
  if (!boundary.fs.exists(path)) return null;
  const contents = boundary.fs.read(path);
  const stranded = swappableTargets(project).find((swap) =>
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
 * A no-op without a variant slug: a plain build keeps full entitlements.
 */
const FATAL_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** 128 + signal number, the conventional exit code for a signalled death. */
const SIGNAL_EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

export async function withEntitlementSwap<T>(
  boundary: Boundary,
  project: Project,
  options: { suffix: string; backupPath: string },
  body: () => Promise<T>,
): Promise<T> {
  if (!options.suffix || swappableTargets(project).length === 0) return body();

  const stranded = findStrandedSwap(boundary, project);
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
    boundary.log.info('restoring the project file (variant entitlement swap)');
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
    boundary.log.step('patching the project file → reduced variant entitlements');
    applySwap(boundary, project);
    swapped = true;
    return await body();
  } finally {
    restore();
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  }
}
