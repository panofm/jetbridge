/**
 * Driving xcodebuild.
 *
 * Every argument is assembled here and nowhere else, so what the build actually
 * runs is one readable list — and one thing a test can assert without Xcode
 * installed.
 */
import { join } from 'node:path';
import { z } from 'zod';
import { localCredentials } from './asc.js';
import type { Boundary, CommandResult } from './boundary.js';
import { resolveTargets } from './bundle-ids.js';
import type { Config } from './config.js';
import { fail, type Project } from './project.js';
import { projectSpecName, ungeneratedAdvice } from './project-layout.js';
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
  /** Drop `-quiet`, so the whole xcodebuild log streams out. */
  verbose?: boolean;
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
    ...(request.gitSha ? [`JETBRIDGE_GIT_SHA=${request.gitSha}`] : []),
    ...variantSettings(request.suffix, request.displayName),
    ...signSettings(request.suffix, request.profiles, resolveTargets(boundary, project)),
    '-allowProvisioningUpdates',
    ...authArgs(boundary, config),
    ...(request.verbose ? [] : ['-quiet']),
  ];
}

export type Platform = 'iphoneos' | 'iphonesimulator';

/** Where a build product lands for a given configuration and platform. */
export function productPath(
  request: Pick<BuildRequest, 'derivedDataPath' | 'configuration'>,
  productName: string,
  platform: Platform,
): string {
  return join(
    request.derivedDataPath,
    'Build',
    'Products',
    `${request.configuration}-${platform}`,
    productName,
  );
}

/**
 * `-showBuildSettings` for the build that just ran: the same scheme,
 * configuration, destination and DerivedData, plus the variant overrides a
 * `PRODUCT_NAME` could refer to. No provisioning flags — it signs nothing.
 */
export function settingsArgs(project: Project, request: BuildRequest): string[] {
  return [
    '-showBuildSettings',
    '-json',
    ...project.xcodebuildTarget(),
    '-scheme',
    project.config.project.scheme,
    '-configuration',
    request.configuration,
    '-destination',
    request.destination,
    '-derivedDataPath',
    request.derivedDataPath,
    ...variantSettings(request.suffix, request.displayName),
  ];
}

const SettingsOutput = z.array(
  z.object({
    buildSettings: z.object({
      PRODUCT_TYPE: z.string().optional(),
      FULL_PRODUCT_NAME: z.string().optional(),
    }),
  }),
);

/**
 * The app's file name — `Acme.app` — from `-showBuildSettings -json`, or null
 * unless the scheme builds exactly one app. The exact product type leaves out
 * watch apps, App Clips and iMessage apps.
 */
export function appProductName(stdout: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  const parsed = SettingsOutput.safeParse(json);
  if (!parsed.success) return null;
  const apps = parsed.data.filter(
    (entry) => entry.buildSettings.PRODUCT_TYPE === 'com.apple.product-type.application',
  );
  return apps.length === 1 ? (apps[0]!.buildSettings.FULL_PRODUCT_NAME ?? null) : null;
}

/**
 * The `.app` the build just produced, named by the build settings.
 *
 * `PRODUCT_NAME` is the project's choice, and a scheme `Acme` that builds
 * `Wave.app` is ordinary. Guessing `<scheme>.app` there is worse than failing:
 * the cached DerivedData still holds the app from before the rename, and that
 * stale build is what would install. The scheme's name is only the fallback for
 * when xcodebuild cannot answer, and the run says so.
 */
export async function builtApp(
  boundary: Boundary,
  project: Project,
  request: BuildRequest,
  platform: Platform,
): Promise<string> {
  const name = await boundary.report.run('settings', 'read build settings', async (step) => {
    const result = await boundary.exec.run('xcodebuild', settingsArgs(project, request), {
      cwd: project.root,
      allowFail: true,
    });
    const found = result.ok ? appProductName(result.stdout) : null;
    const name = found ?? `${project.config.project.scheme}.app`;
    if (!found) {
      boundary.report.note(`the build settings name no single app — assuming ${name}`);
    }
    step.detail(name);
    step.data({ product: name });
    return name;
  });
  const path = productPath(request, name, platform);
  if (!boundary.fs.exists(path)) fail(`the build reported success but produced no app at ${path}`);
  return path;
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
  // A generated project is absent this early on purpose — `generateProject`
  // runs after the header, which is where a slow step belongs. Refusing here
  // would refuse the run jetbridge was configured to make work.
  const spec = projectSpecName(boundary, project.iosPath());
  if (spec && project.config.project.xcodegen && !project.xcodeprojName()) return;

  const [, target] = project.xcodebuildTarget();
  if (!boundary.fs.exists(target)) {
    fail(
      `missing ${target}.\n` +
        (spec
          ? `  ${ungeneratedAdvice(project.iosPath())}`
          : '  Check project.iosDir and project.xcodeproj in the config.'),
    );
  }
}

/** Regenerate the project from its spec, when the config says it is generated. */
export async function generateProject(boundary: Boundary, project: Project): Promise<void> {
  if (!project.config.project.xcodegen) return;
  const directory = project.iosPath();
  if (!projectSpecName(boundary, directory)) {
    fail(
      `project.xcodegen is on, but ${directory} holds no project.yml or project.yaml to ` +
        'generate from.',
    );
  }
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
/**
 * What actually went wrong, out of thousands of lines.
 *
 * `-quiet` keeps the log readable but leaves a failure reading only
 * "** ARCHIVE FAILED **", which names nothing. The lines worth printing are the
 * ones Xcode marks as errors, plus the signing diagnostics it phrases without
 * the word "error" at all — "No profile for team", "doesn't include signing
 * certificate", "requires a provisioning profile". Those are most of what goes
 * wrong here, and none of them appear in a blind tail.
 */
const FAILURE_PATTERNS = [
  /(^|\s)error:/i,
  /\bfatal error\b/i,
  /No profiles? for/i,
  /doesn't include signing certificate/i,
  /requires a provisioning profile/i,
  /provisioning profile .* (not found|doesn't|does not)/i,
  /Code Signing Error/i,
  /No signing certificate/i,
  /is not available/i,
];

export function explainBuildFailure(stdout: string, stderr: string): string {
  const lines = `${stdout}\n${stderr}`.split('\n').map((line) => line.trimEnd());
  const interesting = lines.filter(
    (line) => line.trim() && FAILURE_PATTERNS.some((pattern) => pattern.test(line)),
  );

  // Deduplicate: Xcode repeats the same signing error once per target, per
  // configuration, and the repetition buries everything else.
  const unique = [...new Set(interesting)];
  if (unique.length > 0) return unique.slice(0, 12).join('\n');

  const tail = lines.filter((line) => line.trim()).slice(-20);
  return tail.length > 0
    ? `${tail.join('\n')}\n\n  Nothing in that output names a cause. Re-run with --verbose for the full log.`
    : '  xcodebuild printed nothing. Re-run with --verbose for the full log.';
}

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
      fail(`xcodebuild failed:\n${explainBuildFailure(result.stdout, result.stderr)}`);
    }
    return result;
  });
}
