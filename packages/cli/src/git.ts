/**
 * Git, only as far as naming a variant needs it.
 *
 * Everything here degrades rather than throws: jetbridge has to work in a
 * checkout that is not a git repository at all, and in a repository whose
 * default branch is not the one this tool happens to assume.
 */
import type { Boundary } from './boundary.js';
import { fail, type Project } from './project.js';

export interface GitStamp {
  sha: string;
  shortSha: string;
  /** Tracked files are modified, so the binary would not match the stamped SHA. */
  dirty: boolean;
}

/** The current branch, or empty outside a repository or on a detached HEAD. */
export function currentBranch(boundary: Boundary, cwd: string): string {
  const result = boundary.exec.runSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    allowFail: true,
  });
  if (!result.ok) return '';
  const branch = result.stdout.trim();
  return branch === 'HEAD' ? '' : branch;
}

export function onDefaultBranch(boundary: Boundary, project: Project): boolean {
  return currentBranch(boundary, project.root) === project.config.git.defaultBranch;
}

/**
 * What this checkout would build.
 *
 * Untracked files are ignored deliberately: they are not in the project file,
 * so they cannot reach the binary, and a working checkout routinely carries
 * harmless untracked files.
 */
export function gitStamp(boundary: Boundary, cwd: string): GitStamp | null {
  const head = boundary.exec.runSync('git', ['rev-parse', 'HEAD'], { cwd, allowFail: true });
  if (!head.ok) return null;
  const sha = head.stdout.trim();
  const status = boundary.exec.runSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd,
    allowFail: true,
  });
  return { sha, shortSha: sha.slice(0, 7), dirty: status.stdout.trim() !== '' };
}

/** A bare `--suffix` means "name it after the branch I am on". */
export function branchSuffix(boundary: Boundary, project: Project): string {
  const branch = currentBranch(boundary, project.root);
  if (!branch) {
    fail(
      '--suffix needs a value here: there is no current git branch to derive one from.\n' +
        '  Pass one explicitly, e.g. --suffix wave.',
    );
  }
  return branch;
}

/**
 * The provenance gate for a plain install.
 *
 * A plain build overwrites the app every branch shares, so its vintage has to
 * be knowable on the phone. A variant is exempt — a branch build is its whole
 * point, and the branch is on the home screen.
 *
 * Off unless the project asks for it: this is a strong convention, not a
 * universal one.
 */
export async function requireCleanDefaultBranch(
  boundary: Boundary,
  project: Project,
  suffix: string,
): Promise<GitStamp | null> {
  const { config } = project;
  if (suffix || !config.git.requireCleanDefaultBranch) {
    return gitStamp(boundary, project.root);
  }

  const stamp = gitStamp(boundary, project.root);
  if (!stamp) return null;

  const branch = config.git.defaultBranch;
  // Fetch first, so the comparison is against the remote's branch rather than
  // whatever a stale local ref remembers. Being offline is survivable.
  const remote = config.git.remote;
  const fetched = await boundary.exec.run('git', ['fetch', remote, branch, '--quiet'], {
    cwd: project.root,
    allowFail: true,
  });
  if (!fetched.ok) {
    boundary.log.warn(`could not fetch ${remote}/${branch} — comparing against the local ref`);
  }
  const resolved = boundary.exec.runSync('git', ['rev-parse', `${remote}/${branch}`], {
    cwd: project.root,
    allowFail: true,
  });
  const remoteSha = resolved.stdout.trim();

  if (!resolved.ok || stamp.sha !== remoteSha || stamp.dirty) {
    const why = !resolved.ok
      ? `${remote}/${branch} could not be resolved`
      : stamp.sha !== remoteSha
        ? `HEAD is ${stamp.shortSha}, ${remote}/${branch} is ${remoteSha.slice(0, 7)}`
        : 'the working tree has uncommitted changes to tracked files';
    fail(
      `a plain install must build exactly ${remote}/${branch} — ${why}.\n` +
        '  The plain app is shared by every branch, so a branch or dirty build makes its\n' +
        `  vintage unknowable on the phone. Either merge first and install from ${branch},\n` +
        '  or install this branch beside it as its own app with --suffix.',
    );
  }
  return stamp;
}

/** The provenance stamp passed to the build, when there is one. */
export const stampSetting = (stamp: GitStamp | null): string | undefined =>
  stamp ? `${stamp.shortSha}${stamp.dirty ? '-dirty' : ''}` : undefined;
