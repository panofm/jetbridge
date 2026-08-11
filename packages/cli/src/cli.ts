/**
 * The command line.
 *
 * Argument parsing and printing only — every command delegates immediately.
 * The one piece of real logic here is deciding what a variant is called, which
 * has to be the same answer for every delivery route.
 */
import chalk from 'chalk';
import { Command, InvalidArgumentError } from 'commander';
import { nodeBoundary, nodeReporter, type Boundary } from './boundary.js';
import { listBundles, provisionBundles, pruneBundles, removeBundles } from './bundles.js';
import { loadEnv } from './env.js';
import { runInit } from './init.js';
import { otaInstall, reindex } from './ota.js';
import { clackPrompter } from './prompts.js';
import { JetbridgeError, fail, loadProject, type Project } from './project.js';
import { simInstall } from './sim.js';
import { assertSingleSegment, displayNameFor, sanitizeName, sanitizeSuffix } from './variant.js';
import { branchSuffix } from './git.js';
import { wiredInstall } from './wired.js';

interface VariantOptions {
  suffix?: string | boolean;
  name?: string;
}

interface ResolvedVariant {
  suffix: string;
  displayName: string;
}

/**
 * What this build is called.
 *
 * `--suffix` takes an OPTIONAL value: commander hands back `true` when the flag
 * was given without one, which is the "name it after the branch" signal. The
 * RAW string feeds the label, because it still has the word boundaries a bundle
 * id cannot carry (`seeded-feed` → "Acme Seeded Feed"); the sanitized slug
 * feeds the bundle id.
 */
function resolveVariant(
  boundary: Boundary,
  project: Project,
  options: VariantOptions,
): ResolvedVariant {
  const raw =
    options.suffix === true
      ? branchSuffix(boundary, project)
      : typeof options.suffix === 'string'
        ? options.suffix
        : '';
  return {
    suffix: raw ? sanitizeSuffix(raw, project.config) : '',
    displayName: displayNameFor(raw, options.name ?? '', project.config),
  };
}

const program = new Command();

/**
 * `--json` on every command, not only the root.
 *
 * Commander has no global options: an option declared on the parent is a parse
 * error after the subcommand name, which is exactly where a person types it.
 * So it is declared everywhere and read back with `optsWithGlobals`, and both
 * `jetbridge --json install` and `jetbridge install --json` work.
 */
const machine = (command: Command): Command =>
  command.option('--json', 'newline-delimited JSON events on stdout, for scripts and agents');

program
  .name('jetbridge')
  .description('Build, sign and deliver iOS dev builds — to a simulator, a cable, or your bucket.')
  .option('--config-file <path>', 'use this config file instead of the nearest one')
  // Never REQUIRED: behind a pipe the unattended path is already automatic, so
  // an agent needs no flag and no environment variable. This is for a person on
  // a terminal who wants it anyway.
  .option('--non-interactive', 'never prompt, even on a terminal')
  .showHelpAfterError();
machine(program);

/**
 * One reporter for the whole run, replaced once the flags are parsed.
 *
 * It exists before parsing because the failure path needs somewhere to write:
 * `open()` throws when there is no config file, and by then the boundary that
 * would have carried a reporter was never built.
 */
let reporter = nodeReporter();
program.hook('preAction', (_root, action) => {
  if (action.optsWithGlobals().json) reporter = nodeReporter({ json: true });
});

/** Resolved per command, so `--config-file` on the root still applies. */
const open = (): { boundary: Boundary; project: Project } => {
  const boundary = nodeBoundary({
    nonInteractive: Boolean(program.opts().nonInteractive),
    reporter,
  });
  const configPath = program.opts().configFile as string | undefined;
  const project = loadProject(boundary, { configPath });
  // After the project is found, because the files are read relative to its
  // root — and before any command runs, because credentials come from them.
  loadEnv(boundary, project.root);
  return { boundary, project };
};

const parseName = (value: string): string => {
  try {
    return sanitizeName(value);
  } catch {
    throw new InvalidArgumentError('must contain letters or digits');
  }
};

/** Rejects a pasted bundle id rather than quietly flattening it into one segment. */
const parseSuffix = (value: string): string => {
  if (value.includes('.')) {
    throw new InvalidArgumentError('just the last segment — the full bundle id is built for you');
  }
  if (!/[A-Za-z0-9]/.test(value)) {
    throw new InvalidArgumentError('must contain letters or digits');
  }
  return value;
};

const SUFFIX_FLAG = '-s, --suffix [slug]';
const SUFFIX_HELP = 'variant build; a bare flag names it after the current git branch';
const NAME_FLAG = '-n, --name <name>';
const NAME_HELP = 'home-screen display name';

machine(program.command('init'))
  .description('write jetbridge.config.json by inspecting this Xcode project')
  .option('-y, --yes', 'accept every detected default and never prompt')
  .option('--ios-dir <dir>', 'directory holding the Xcode project')
  .option('--scheme <name>', 'scheme to build')
  .option('--team-id <id>', 'Apple team id')
  .option('--bundle-id <id>', 'base bundle id')
  .option('--display-name <name>', 'home-screen label for a plain build')
  .option('--ota', 'configure over-the-air delivery')
  .option('--ota-bucket <name>')
  .option('--ota-region <region>')
  .option('--ota-endpoint <url>', 'for an S3-compatible host (R2, MinIO, Backblaze)')
  .option('--ota-public-base-url <url>', 'where uploaded builds are readable (https only)')
  .action(async (options) => {
    const boundary = nodeBoundary({
      nonInteractive: Boolean(program.opts().nonInteractive),
      reporter,
    });
    boundary.report.start({ command: 'init', title: ['jetbridge init'] });
    const result = await runInit(
      boundary,
      {
        yes: Boolean(options.yes),
        iosDir: options.iosDir,
        scheme: options.scheme,
        teamId: options.teamId,
        bundleId: options.bundleId,
        displayName: options.displayName,
        ota: Boolean(options.ota),
        otaBucket: options.otaBucket,
        otaRegion: options.otaRegion,
        otaEndpoint: options.otaEndpoint,
        otaPublicBaseUrl: options.otaPublicBaseUrl,
      },
      { prompts: clackPrompter() },
    );
    if (result.status === 'written')
      boundary.report.note(chalk.green(`wrote ${result.configPath}`));
    else if (result.status === 'unchanged') {
      boundary.report.note(chalk.dim(`${result.configPath} is already up to date`));
    } else boundary.report.note(chalk.dim('nothing written'));
    boundary.report.emit('init', {
      status: result.status,
      ...(result.configPath ? { configPath: result.configPath } : {}),
    });
    boundary.report.done(true, { status: result.status });
  });

/**
 * Where the build goes.
 *
 * Both flags take an OPTIONAL value, so one flag answers two questions:
 * `--device` means the cable, and `--device <id>` means that phone. The
 * simulator is the default because it is the only route that needs no
 * credentials, no signing and no paired hardware — a first command on a new
 * machine always works.
 */
function resolveDestination(options: { device?: string | boolean; simulator?: string | boolean }): {
  kind: 'device' | 'simulator';
  id: string;
} {
  const wantsDevice = options.device !== undefined;
  const wantsSimulator = options.simulator !== undefined;
  // Inside an action handler, so `fail` — a commander parse error here would
  // print a stack instead of the one line an expected failure gets.
  if (wantsDevice && wantsSimulator) fail('pass --device or --simulator, not both');
  const chosen = wantsDevice ? options.device : options.simulator;
  return {
    kind: wantsDevice ? 'device' : 'simulator',
    id: typeof chosen === 'string' ? chosen : '',
  };
}

machine(program.command('install'))
  .description('build and install — on a simulator by default, or over the cable with --device')
  .option(SUFFIX_FLAG, SUFFIX_HELP, parseSuffix)
  .option(NAME_FLAG, NAME_HELP, parseName)
  .option('-d, --device [id]', 'install over the cable; give an id to pick one device')
  .option('--simulator [name]', 'install on a simulator (the default); give a name or udid')
  // `--configuration`, not `--config`: Xcode's own word, and one keystroke
  // from the root `--config-file` is two meanings of "config" too close together.
  .option('-c, --configuration <name>', 'build configuration')
  .option('--clean', 'wipe cached DerivedData first')
  .option('--reprovision', 'bypass the profile cache and provision fresh (--device only)')
  .action(async (options) => {
    const { boundary, project } = open();
    const destination = resolveDestination(options);
    const variant = resolveVariant(boundary, project, options);

    if (destination.kind === 'simulator') {
      if (options.reprovision) fail('--reprovision only applies to a --device install');
      await simInstall(boundary, project, {
        ...variant,
        device: destination.id,
        configuration: options.configuration,
        clean: Boolean(options.clean),
      });
      return;
    }

    await wiredInstall(boundary, project, {
      ...variant,
      device: destination.id,
      configuration: options.configuration,
      clean: Boolean(options.clean),
      reprovision: Boolean(options.reprovision),
    });
  });

machine(program.command('link'))
  .description('archive, upload to your bucket, and print a link anyone can install from')
  .option(SUFFIX_FLAG, SUFFIX_HELP, parseSuffix)
  .option(NAME_FLAG, NAME_HELP, parseName)
  // `--configuration`, not `--config`: Xcode's own word, and one keystroke
  // from the root `--config-file` is two meanings of "config" too close together.
  .option('-c, --configuration <name>', 'build configuration')
  .action(async (options) => {
    const { boundary, project } = open();
    await otaInstall(boundary, project, {
      ...resolveVariant(boundary, project, options),
      configuration: options.configuration,
    });
  });

machine(program.command('reindex'))
  .description('rebuild the build index page from what is in the bucket')
  .action(async () => {
    const { boundary, project } = open();
    boundary.report.start({
      command: 'reindex',
      title: ['reindex', project.config.project.baseBundleId],
    });
    const result = await reindex(boundary, project, {});
    boundary.report.note(chalk.green(`rebuilt: ${result.indexUrl}`));
    boundary.report.done(true, { builds: result.builds });
  });

/**
 * Everything this project has registered with Apple.
 *
 * A noun-first group, in the shape of `docker image ls/rm/prune`: the bare verb
 * that used to live here said nothing about what it acted on, and what it acts
 * on is permanent account state that Apple will not restore.
 */
const bundles = machine(
  program
    .command('bundles')
    .description('variant bundle ids and profiles registered with Apple for this project'),
);

machine(bundles.command('ls', { isDefault: true }))
  .alias('list')
  .description('what this project has registered')
  .action(async () => {
    const { boundary, project } = open();
    // Read off the reporter, not the action's own options: commander hoists a
    // repeated flag to the ancestor that declared it first, so `--json` lands in
    // a different bag depending on where it was typed. The hook already resolved it.
    await listBundles(boundary, project, { json: boundary.report.json });
  });

machine(bundles.command('provision [slug]'))
  .description('register and refresh profiles now, without building')
  .action(async (slug: string | undefined) => {
    const { boundary, project } = open();
    const variant = resolveVariant(boundary, project, { suffix: slug ?? true });
    await provisionBundles(boundary, project, variant);
  });

machine(bundles.command('rm <slug...>'))
  .description('remove these variants by name')
  .option('-y, --yes', 'actually delete (without this, the plan is printed and nothing changes)')
  .action(async (slugs: string[], options: { yes?: boolean }) => {
    // Validate the arguments BEFORE loading the config: a variadic argument
    // gets no commander parser, and checking afterwards means a typo outside a
    // project is reported as a missing config file — the wrong problem.
    for (const slug of slugs) assertSingleSegmentLoose(slug);
    const { boundary, project } = open();
    await removeBundles(boundary, project, {
      suffixes: slugs.map((value) => sanitizeSuffix(value, project.config)),
      yes: Boolean(options.yes),
    });
  });

machine(bundles.command('prune'))
  .description('remove variants whose git branch is gone from the remote')
  .option('-y, --yes', 'actually delete (without this, the plan is printed and nothing changes)')
  .action(async (options: { yes?: boolean }) => {
    const { boundary, project } = open();
    await pruneBundles(boundary, project, { yes: Boolean(options.yes) });
  });

/**
 * The config is not loaded yet, so the base bundle id cannot be quoted back —
 * but a pasted bundle id still has to be refused rather than flattened into one
 * absurd segment.
 */
function assertSingleSegmentLoose(value: string): string {
  if (value.includes('.')) {
    fail(`"${value}": just the last segment — the full bundle id is built for you (e.g. "wave")`);
  }
  return value;
}

// A `JetbridgeError` is an expected failure that has already explained itself,
// so it prints as one line. Anything else is a bug, and its stack is the point.
try {
  await program.parseAsync(process.argv);
} catch (error) {
  const message =
    error instanceof JetbridgeError ? error.message : ((error as Error)?.stack ?? String(error));
  reporter.error(message);
  reporter.done(false);
  // `exitCode`, never `exit`: stdout is a pipe whenever `--json` is worth
  // having, and `process.exit` drops whatever is still in its buffer — which is
  // the error event, the one line a consumer is waiting for.
  process.exitCode = 1;
}

export { assertSingleSegment, resolveVariant };
