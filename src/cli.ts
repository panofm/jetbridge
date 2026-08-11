/**
 * The command line.
 *
 * Argument parsing and printing only — every command delegates immediately.
 * The one piece of real logic here is deciding what a variant is called, which
 * has to be the same answer for every delivery route.
 */
import chalk from 'chalk';
import { Command, InvalidArgumentError } from 'commander';
import { nodeBoundary, type Boundary } from './boundary.js';
import { cleanVariants } from './clean.js';
import { runInit } from './init.js';
import { otaInstall, reindex } from './ota.js';
import { clackPrompter } from './prompts.js';
import { JetbridgeError, loadProject, type Project } from './project.js';
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

program
  .name('jetbridge')
  .description('Build, sign and deliver iOS dev builds — to a simulator, a cable, or your bucket.')
  .option('--config-file <path>', 'use this config file instead of the nearest one')
  .showHelpAfterError();

/** Resolved per command, so `--config-file` on the root still applies. */
const open = (): { boundary: Boundary; project: Project } => {
  const boundary = nodeBoundary();
  const configPath = program.opts().configFile as string | undefined;
  return { boundary, project: loadProject(boundary, { configPath }) };
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

program
  .command('init')
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
    const boundary = nodeBoundary();
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
    if (result.status === 'written') console.error(chalk.green(`wrote ${result.configPath}`));
    else if (result.status === 'unchanged') {
      console.error(chalk.dim(`${result.configPath} is already up to date`));
    } else console.error(chalk.dim('nothing written'));
  });

program
  .command('sim')
  .description('build and launch on a simulator (no signing, so a variant needs no credentials)')
  .option(SUFFIX_FLAG, SUFFIX_HELP, parseSuffix)
  .option(NAME_FLAG, NAME_HELP, parseName)
  .option('-d, --device <id>', 'simulator name or udid')
  .option('-c, --config <name>', 'build configuration')
  .option('--clean', 'wipe cached DerivedData first')
  .action(async (options) => {
    const { boundary, project } = open();
    await simInstall(boundary, project, {
      ...resolveVariant(boundary, project, options),
      device: options.device,
      configuration: options.config,
      clean: Boolean(options.clean),
    });
  });

program
  .command('wired')
  .description('build and install over the cable to every reachable paired device')
  .option(SUFFIX_FLAG, SUFFIX_HELP, parseSuffix)
  .option(NAME_FLAG, NAME_HELP, parseName)
  .option('-d, --device <id>', 'install to one device (identifier, name, udid or serial)')
  .option('-c, --config <name>', 'build configuration')
  .option('--clean', 'wipe cached DerivedData first')
  .option('--reprovision', 'bypass the profile cache and provision fresh')
  .action(async (options) => {
    const { boundary, project } = open();
    await wiredInstall(boundary, project, {
      ...resolveVariant(boundary, project, options),
      device: options.device,
      configuration: options.config,
      clean: Boolean(options.clean),
      reprovision: Boolean(options.reprovision),
    });
  });

program
  .command('ota')
  .description('archive, upload to your bucket, and print an install URL')
  .option(SUFFIX_FLAG, SUFFIX_HELP, parseSuffix)
  .option(NAME_FLAG, NAME_HELP, parseName)
  .option('-c, --config <name>', 'build configuration')
  .action(async (options) => {
    const { boundary, project } = open();
    const result = await otaInstall(boundary, project, {
      ...resolveVariant(boundary, project, options),
      configuration: options.config,
    });
    console.error('');
    console.error(chalk.green(`install: ${result.installUrl}`));
    console.error(chalk.dim(`builds:  ${result.indexUrl}`));
  });

program
  .command('reindex')
  .description('rebuild the build index page from what is in the bucket')
  .action(async () => {
    const { boundary, project } = open();
    const url = await reindex(boundary, project, {});
    console.error(chalk.green(`rebuilt: ${url}`));
  });

program
  .command('clean')
  .description('remove variant bundle ids and profiles from the developer account')
  .option('-s, --suffix <slug>', 'variant to remove; repeatable', (value: string, all: string[]) =>
    all.concat(assertSingleSegmentLoose(value)),
  )
  .option('-a, --all', 'every registered variant')
  .option('-y, --yes', 'actually delete (without this, the plan is printed and nothing changes)')
  .action(async (options: { suffix: string[]; all?: boolean; yes?: boolean }) => {
    const { boundary, project } = open();
    await cleanVariants(boundary, project, {
      suffixes: (options.suffix ?? []).map((value) => sanitizeSuffix(value, project.config)),
      all: Boolean(options.all),
      yes: Boolean(options.yes),
    });
  });

/** The project is not loaded yet when commander parses this option. */
function assertSingleSegmentLoose(value: string): string {
  if (value.includes('.')) {
    throw new InvalidArgumentError('just the last segment of the bundle id');
  }
  return value;
}

// A `JetbridgeError` is an expected failure that has already explained itself,
// so it prints as one line. Anything else is a bug, and its stack is the point.
try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof JetbridgeError) {
    console.error(chalk.red(`✗ ${error.message}`));
  } else {
    console.error(chalk.red(`✗ ${(error as Error)?.stack ?? String(error)}`));
  }
  process.exit(1);
}

export { assertSingleSegment, resolveVariant };
