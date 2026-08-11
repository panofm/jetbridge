/**
 * The command line is the first thing every user touches, and the one file
 * where a mistake is invisible from every other test: the delivery modules are
 * all covered, but nothing checked that `--suffix` reaches them, or reaches all
 * three of them with the SAME answer.
 *
 * Two levels, because the file has two halves:
 *   - In process, with the delivery modules mocked, for what commander parses
 *     and hands on. `src/cli.ts` calls `parseAsync` at module scope, so the
 *     import IS the run: set `process.argv`, reset the module registry, import.
 *   - As a subprocess against the built `dist/cli.js`, for what only exists at
 *     the argv level — help, exit codes, and the difference between an expected
 *     failure and a stack trace. Skipped when `dist/` is absent, so a clean
 *     checkout still passes; run `npm run build` to include them.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as projectModule from '../src/project.js';
import { projectFrom, type Project } from '../src/project.js';
import { testConfig } from './helpers/config.js';

type ProjectModule = typeof projectModule;

/** Hoisted: a `vi.mock` factory runs before ordinary module scope does. */
const captured = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; options: Record<string, unknown> }>,
  loads: [] as Array<string | undefined>,
  branch: 'feat/seeded-feed',
}));

const record =
  (command: string) =>
  async (_boundary: unknown, _project: unknown, options: Record<string, unknown>) => {
    captured.calls.push({ command, options });
    return { installUrl: 'https://builds.example.com/i', indexUrl: 'https://builds.example.com/x' };
  };

vi.mock('../src/sim.js', () => ({ simInstall: record('sim') }));
vi.mock('../src/wired.js', () => ({
  wiredInstall: record('wired'),
  derivedDataPath: () => '/dd',
  scratchPath: () => '/scratch',
}));
vi.mock('../src/ota.js', () => ({ otaInstall: record('ota'), reindex: record('reindex') }));
vi.mock('../src/bundles.js', () => ({
  listBundles: record('bundles:ls'),
  provisionBundles: record('bundles:provision'),
  removeBundles: record('bundles:rm'),
  pruneBundles: record('bundles:prune'),
}));
vi.mock('../src/init.js', () => ({ runInit: async () => ({ status: 'skipped' as const }) }));
vi.mock('../src/git.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  branchSuffix: () => captured.branch,
}));
vi.mock('../src/project.js', async (importOriginal) => {
  const actual = await importOriginal<ProjectModule>();
  return {
    ...actual,
    loadProject: (_boundary: unknown, options: { configPath?: string } = {}) => {
      captured.loads.push(options.configPath);
      return project;
    },
  };
});

const project: Project = projectFrom(
  '/w/jetbridge.config.json',
  testConfig({
    variant: {
      displayName: 'Acme Dev',
      targets: [{ name: 'Acme' }],
    },
  }),
);

/** One run of the CLI, exactly as `jetbridge <args>` would. */
async function runCli(...args: string[]): Promise<typeof captured.calls> {
  captured.calls.length = 0;
  captured.loads.length = 0;
  vi.resetModules();
  process.argv = ['/usr/bin/node', '/usr/local/bin/jetbridge', ...args];
  await import('../src/cli.js');
  return captured.calls;
}

const originalArgv = process.argv;

// The CLI prints its result to stderr, which is the point of the CLI and noise
// in a test log.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.argv = originalArgv;
  captured.branch = 'feat/seeded-feed';
  vi.restoreAllMocks();
});

describe('naming a variant', () => {
  it('derives the slug and the label from an explicit --suffix', async () => {
    const [call] = await runCli('install', '--suffix', 'seeded-feed');
    expect(call!.options).toMatchObject({
      suffix: 'seededfeed',
      displayName: 'Acme Seeded Feed',
    });
  });

  it('names a bare --suffix after the current branch', async () => {
    const [call] = await runCli('install', '--suffix');
    expect(call!.options).toMatchObject({
      suffix: 'seededfeed',
      displayName: 'Acme Seeded Feed',
    });
  });

  it('keeps the project default when there is no --suffix at all', async () => {
    const [call] = await runCli('install');
    expect(call!.options).toMatchObject({ suffix: '', displayName: 'Acme Dev' });
  });

  it('gives sim, wired and ota the SAME name for one branch', async () => {
    // A divergence here installs two differently-named apps from one branch,
    // which is the exact failure variants exist to prevent.
    const named = async (...argv: string[]) => {
      const [call] = await runCli(...argv);
      return { suffix: call!.options.suffix, displayName: call!.options.displayName };
    };
    const explicit = await Promise.all(
      [['install'], ['install', '--device'], ['link']].map((argv) =>
        named(...argv, '--suffix', 'seeded-feed'),
      ),
    );
    expect(explicit[1]).toEqual(explicit[0]);
    expect(explicit[2]).toEqual(explicit[0]);

    const derived = await Promise.all(
      [['install'], ['install', '--device'], ['link']].map((argv) => named(...argv, '--suffix')),
    );
    expect(derived).toEqual(explicit);

    const plain = await Promise.all(
      [['install'], ['install', '--device'], ['link']].map((argv) => named(...argv)),
    );
    expect(plain[1]).toEqual(plain[0]);
    expect(plain[2]).toEqual(plain[0]);
    expect(plain[0]).toEqual({ suffix: '', displayName: 'Acme Dev' });
  });

  it('lets --name override the derived label, without touching the slug', async () => {
    const [call] = await runCli(
      'install',
      '--device',
      '--suffix',
      'seeded-feed',
      '--name',
      'Feed Lab',
    );
    expect(call!.options).toMatchObject({ suffix: 'seededfeed', displayName: 'Feed Lab' });
  });

  it('sanitises a display name that carries punctuation', async () => {
    const [call] = await runCli('install', '--name', 'Acme! (dev)');
    expect(call!.options.displayName).toBe('Acme dev');
  });
});

describe('the other flags each command carries', () => {
  it('passes the simulator, configuration and clean flags through', async () => {
    const [call] = await runCli(
      'install',
      '--simulator',
      'iPhone 17 Pro',
      '--configuration',
      'Debug',
      '--clean',
    );
    expect(call!.options).toMatchObject({
      device: 'iPhone 17 Pro',
      configuration: 'Debug',
      clean: true,
    });
  });

  it('passes reprovision through to wired, which sim has no notion of', async () => {
    const [call] = await runCli('install', '--device', '--reprovision');
    expect(call!.options).toMatchObject({ reprovision: true, clean: false });
  });

  it('passes the configuration through to ota', async () => {
    const [call] = await runCli('link', '--configuration', 'Release');
    expect(call!.options).toMatchObject({ configuration: 'Release' });
  });
});

describe('bundles', () => {
  it('removes only what was named, and only with -y', async () => {
    // Apple restores nothing, so the dry run is the safety property of the
    // whole group, not a convenience.
    const [dry] = await runCli('bundles', 'rm', 'wave');
    expect(dry!.options).toMatchObject({ suffixes: ['wave'], yes: false });

    const [executed] = await runCli('bundles', 'rm', 'wave', '-y');
    expect(executed!.options).toMatchObject({ suffixes: ['wave'], yes: true });
  });

  it('takes several slugs at once and sanitises each', async () => {
    const [call] = await runCli('bundles', 'rm', 'wave', 'seeded-feed');
    expect(call!.options.suffixes).toEqual(['wave', 'seededfeed']);
  });

  it('prunes as a dry run unless -y was passed', async () => {
    const [dry] = await runCli('bundles', 'prune');
    expect(dry!.options).toMatchObject({ yes: false });

    const [executed] = await runCli('bundles', 'prune', '-y');
    expect(executed!.options).toMatchObject({ yes: true });
  });

  it('lists as the default subcommand, so a bare `bundles` lists', async () => {
    const [bare] = await runCli('bundles');
    expect(bare!.command).toBe('bundles:ls');

    const [explicit] = await runCli('bundles', 'ls');
    expect(explicit!.command).toBe('bundles:ls');
  });

  it('offers machine-readable output, because agents consume it', async () => {
    const [call] = await runCli('bundles', 'ls', '--json');
    expect(call!.options).toMatchObject({ json: true });
  });

  it('provisions a named slug without building', async () => {
    const [call] = await runCli('bundles', 'provision', 'wave');
    expect(call!.options).toMatchObject({ suffix: 'wave' });
  });
});

describe('--config-file', () => {
  it('reaches the subcommand, not only the root parser', async () => {
    await runCli('--config-file', '/elsewhere/jetbridge.config.json', 'install');
    expect(captured.loads).toEqual(['/elsewhere/jetbridge.config.json']);
  });

  it('leaves the config path unset when the flag is absent, so the walk-up runs', async () => {
    await runCli('install');
    expect(captured.loads).toEqual([undefined]);
  });
});

// ─── the built CLI, as a user runs it ────────────────────────────────────────

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
const built = existsSync(DIST);

const exec = promisify(execFile);

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  output: string;
}

/** Run the built CLI somewhere with no config above it, and never throw. */
async function cli(...args: string[]): Promise<CliResult> {
  const cwd = mkdtempSync(join(tmpdir(), 'jetbridge-cli-'));
  try {
    const { stdout, stderr } = await exec(process.execPath, [DIST, ...args], { cwd });
    return { code: 0, stdout, stderr, output: stdout + stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    const stdout = failure.stdout ?? '';
    const stderr = failure.stderr ?? '';
    return { code: failure.code ?? 1, stdout, stderr, output: stdout + stderr };
  }
}

describe.skipIf(!built)('the built CLI', () => {
  it('lists every command in the root help', async () => {
    const result = await cli('--help');
    expect(result.code).toBe(0);
    for (const command of ['init', 'install', 'link', 'bundles', 'reindex']) {
      expect(result.output).toContain(command);
    }
  });

  it('documents each command with its own flags', async () => {
    const sim = await cli('install', '--help');
    expect(sim.output).toContain('--suffix');
    expect(sim.output).toContain('--name');
    expect(sim.output).toContain('--device');
    expect(sim.output).toContain('--clean');
    expect(sim.output).toContain('--reprovision');

    const wired = await cli('install', '--device', '--help');
    expect(wired.output).toContain('--reprovision');

    const ota = await cli('link', '--help');
    expect(ota.output).toContain('--suffix');
    expect(ota.output).toContain('--configuration <name>');

    const bundles = await cli('bundles', '--help');
    expect(bundles.output).toContain('prune');
    expect(bundles.output).toContain('provision');
  });

  it('offers the same variant flags on install and link', async () => {
    const flags = await Promise.all(
      ['install', 'link'].map(async (command) => {
        const help = await cli(command, '--help');
        return ['-s, --suffix [slug]', '-n, --name <name>'].filter((flag) =>
          help.output.includes(flag),
        );
      }),
    );
    expect(flags[1]).toEqual(flags[0]);
    expect(flags[0]).toHaveLength(2);
  });

  it('exits non-zero on an unknown command, and prints the help', async () => {
    const result = await cli('deploy');
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("unknown command 'deploy'");
    expect(result.output).toContain('Usage: jetbridge');
  });

  it('exits non-zero on an unknown flag, and prints the command help', async () => {
    const result = await cli('install', '--nope');
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("unknown option '--nope'");
    expect(result.output).toContain('Usage: jetbridge install');
  });

  it('rejects a pasted bundle id rather than flattening it into a slug', async () => {
    const result = await cli('install', '--suffix', 'io.acme.app.dev.wave');
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('just the last segment');
    expect(result.output).not.toContain('ioacmeappdevwave');
  });

  it('rejects a display name with no letters or digits', async () => {
    const result = await cli('install', '--name', '***');
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('must contain letters or digits');
  });

  it('explains a dotted bundle slug instead of printing a stack', async () => {
    const result = await cli('bundles', 'rm', 'io.acme.app.dev.wave');
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('just the last segment');
    expect(result.output).not.toMatch(/^\s+at /m);
  });

  it('fails outside a project in one line, not a stack trace', async () => {
    const result = await cli('install');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('no jetbridge.config.json found');
    expect(result.stderr).toContain('jetbridge init');
    // An expected failure has already explained itself; a stack means a bug.
    expect(result.stderr).not.toMatch(/^\s+at /m);
    expect(result.stderr).not.toContain('JetbridgeError');
  });

  it('honours --config-file from a subcommand, and names the file it could not find', async () => {
    const result = await cli('--config-file', '/nowhere/jetbridge.config.json', 'install');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('config file not found: /nowhere/jetbridge.config.json');
    expect(result.stderr).not.toMatch(/^\s+at /m);
  });
});

describe.skipIf(built)('the built CLI', () => {
  it.skip('needs `npm run build` — dist/cli.js is not there', () => {});
});
