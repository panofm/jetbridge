/**
 * Driving xcodebuild.
 *
 * Every argument is assembled here and nowhere else, so what the build actually
 * runs is one readable list — and one thing a test can assert without Xcode
 * installed.
 */
import { join } from 'node:path';
import { localCredentials } from './asc.js';
import type { Boundary, CommandResult } from './boundary.js';
import type { Config } from './config.js';
import { fail, type Project } from './project.js';
import { signSettings, variantSettings, type SigningProfiles } from './signing.js';

export interface BuildRequest {
  configuration: string;
  suffix: string;
  displayName: string;
  profiles: SigningProfiles;
  derivedDataPath: string;
  /** `generic/platform=iOS` for a device build, or a simulator destination. */
  destination: string;
  /** Unix seconds; a fresh number every run — see `buildNumber`. */
  buildNumber: string;
  gitSha?: string;
  /** Device builds skip the separate dSYM; an archive keeps it. */
  withDsym?: boolean;
}

/**
 * A build number that always increases.
 *
 * iOS treats "this CFBundleVersion is already installed" as nothing to do: it
 * skips the install without a word, and you keep launching the stale app. A
 * fresh number forces the replacement every time.
 */
export const buildNumber = (boundary: Boundary): string => String(boundary.now());

/**
 * `-authenticationKey*` flags, which let `-allowProvisioningUpdates` refresh a
 * profile headlessly. Empty when this machine has no credentials — a plain
 * build against a cached profile needs none.
 */
export function authArgs(boundary: Boundary, config: Config): string[] {
  const credentials = localCredentials(boundary, config);
  if (!credentials) return [];
  return [
    '-authenticationKeyPath',
    credentials.keyPath,
    '-authenticationKeyID',
    credentials.keyId,
    '-authenticationKeyIssuerID',
    credentials.issuerId,
  ];
}

export function buildArgs(boundary: Boundary, project: Project, request: BuildRequest): string[] {
  const { config } = project;
  return [
    'build',
    ...project.xcodebuildTarget(),
    '-scheme',
    config.project.scheme,
    '-configuration',
    request.configuration,
    '-destination',
    request.destination,
    '-derivedDataPath',
    request.derivedDataPath,
    `CURRENT_PROJECT_VERSION=${request.buildNumber}`,
    // No separate dSYM on the inner loop. Generating one for every target adds
    // seconds to each incremental install, for a debug artifact a dev build
    // never reads: a non-stripped build symbolicates from its own DWARF.
    ...(request.withDsym ? [] : ['DEBUG_INFORMATION_FORMAT=dwarf']),
    ...(request.gitSha ? [`${config.variant.buildSettings.gitSha}=${request.gitSha}`] : []),
    ...variantSettings(request.suffix, request.displayName, config),
    ...signSettings(request.suffix, request.profiles, config),
    '-allowProvisioningUpdates',
    ...authArgs(boundary, config),
    '-quiet',
  ];
}

/** Where a built `.app` lands for a given configuration and platform. */
export function productPath(
  request: Pick<BuildRequest, 'derivedDataPath' | 'configuration'>,
  config: Config,
  platform: 'iphoneos' | 'iphonesimulator',
): string {
  return join(
    request.derivedDataPath,
    'Build',
    'Products',
    `${request.configuration}-${platform}`,
    `${config.project.scheme}.app`,
  );
}

/** Fail before the slow steps if a required tool or the project is missing. */
export async function requireToolchain(
  boundary: Boundary,
  project: Project,
  binaries: string[],
): Promise<void> {
  for (const binary of binaries) {
    const found = await boundary.exec.run('command', ['-v', binary], { allowFail: true });
    if (!found.ok) fail(`${binary} was not found on PATH`);
  }
  const [, target] = project.xcodebuildTarget();
  if (!boundary.fs.exists(target)) {
    fail(
      `missing ${target}.\n` +
        (project.config.project.projectYml
          ? '  Generate the project first, then re-run.'
          : '  Check project.xcodeproj in the config.'),
    );
  }
}

/** Regenerate the project from its spec, when the config says it is generated. */
export async function generateProject(boundary: Boundary, project: Project): Promise<void> {
  if (!project.config.project.xcodegen) return;
  await boundary.report.run('xcodegen', 'generated project', async () => {
    const result = await boundary.exec.run('xcodegen', ['generate'], {
      cwd: project.iosPath(),
      allowFail: true,
    });
    if (!result.ok) fail(`xcodegen failed:\n${(result.stderr || result.stdout).trim()}`);
  });
}

/**
 * Run a configured shell hook in the project root.
 *
 * Its output is captured rather than inherited: a hook that announces itself
 * printed its own name straight after the runner printed it, and anything it
 * wrote mid-step landed between a step's line and its duration. On a failure
 * the tail is quoted, which is the only part anybody reads.
 */
export async function runHook(
  boundary: Boundary,
  project: Project,
  which: 'preBuild' | 'postBuild',
): Promise<void> {
  const command = project.config.hooks[which];
  if (!command) return;
  await boundary.report.run('hook', which, async (step) => {
    step.data({ hook: which, command });
    const result = await boundary.exec.run('/bin/sh', ['-c', command], {
      cwd: project.root,
      allowFail: true,
    });
    if (!result.ok) {
      const tail = (result.stderr || result.stdout).trim().split('\n').slice(-20).join('\n');
      fail(
        `the ${which} hook failed (exit ${result.code}): ${command}` + (tail ? `\n${tail}` : ''),
      );
    }
  });
}

/**
 * The build number is a bare epoch and looks like nothing, so the line that
 * reports it says where the same number appears on the phone.
 */
export const buildNumberDetail = (buildNumber: string): string =>
  `build ${buildNumber} (shown in Settings › App Info)`;

export async function build(
  boundary: Boundary,
  project: Project,
  request: BuildRequest,
): Promise<CommandResult> {
  const args = buildArgs(boundary, project, request);
  return boundary.report.run('build', 'built', async (step) => {
    step.detail(buildNumberDetail(request.buildNumber));
    step.data({ buildNumber: request.buildNumber, configuration: request.configuration });
    const result = await boundary.exec.run('xcodebuild', args, {
      cwd: project.root,
      allowFail: true,
    });
    if (!result.ok) {
      // xcodebuild's useful lines are at the end; the first hundred are noise.
      const tail = (result.stderr || result.stdout).trim().split('\n').slice(-20).join('\n');
      fail(`xcodebuild failed:\n${tail}`);
    }
    return result;
  });
}
