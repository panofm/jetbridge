/**
 * The unattended guarantee: an agent, a pipe or another Claude session drives
 * this CLI with no terminal and NO `CI` variable set, and nothing ever waits for
 * a person.
 *
 * A hang is the worst outcome jetbridge has — the caller waits forever and the
 * session dies having printed nothing — so these tests are written to fail on a
 * wait as well as on a wrong answer. Every case either resolves or throws; the
 * short `testTimeout` below means a genuine hang surfaces as a timeout failure
 * rather than a stuck run.
 */
import { describe, expect, it, vi } from 'vitest';
import { isInteractive, nodeBoundary } from '../src/boundary.js';
import { pruneBundles, removeBundles } from '../src/bundles.js';
import { runInit } from '../src/init.js';
import { otaInstall, reindex } from '../src/ota.js';
import { JetbridgeError, projectFrom, type Project } from '../src/project.js';
import { clackPrompter, nonInteractivePrompter, scriptedPrompter } from '../src/prompts.js';
import { simInstall } from '../src/sim.js';
import { wiredInstall } from '../src/wired.js';
import { testConfig } from './helpers/config.js';
import { fakeBoundary, type FakeBoundary } from './helpers/fake-boundary.js';

/** A wait fails here instead of stalling the suite. */
const HANG_BUDGET_MS = 5_000;

/**
 * The environment these tests describe: no terminal, and — the whole point —
 * no `CI` variable anywhere. Nobody had to set one.
 */
const unattended = (over: Parameters<typeof fakeBoundary>[0] = {}): FakeBoundary =>
  fakeBoundary({ interactive: false, homedir: '/home/dev', ...over });

const project: Project = projectFrom('/w/jetbridge.config.json', testConfig());

/** Stub the real streams, since `isInteractive` reads them directly. */
const withTty = <T>(tty: boolean, body: () => T): T => {
  const stdin = process.stdin.isTTY;
  const stdout = process.stdout.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
  try {
    return body();
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: stdout, configurable: true });
  }
};

describe('no CI variable is required', () => {
  it('is not set in this environment, which is what the rest of the file assumes', () => {
    expect(unattended().env('CI')).toBeUndefined();
  });

  it('not-a-TTY is sufficient on its own — no CI, no flag, no variable', () => {
    // The requirement, stated as one assertion: an empty environment behind a
    // pipe is already non-interactive.
    expect(withTty(false, () => isInteractive({}))).toBe(false);
  });

  it('a terminal with an empty environment is still interactive', () => {
    expect(withTty(true, () => isInteractive({}))).toBe(true);
  });

  it('CI remains an override, so setting it keeps working', () => {
    expect(withTty(true, () => isInteractive({ CI: '1' }))).toBe(false);
  });

  it('JETBRIDGE_NON_INTERACTIVE is the explicit escape hatch on a terminal', () => {
    expect(withTty(true, () => isInteractive({ JETBRIDGE_NON_INTERACTIVE: '1' }))).toBe(false);
  });
});

describe('runInit', () => {
  const detected = {
    '/w/ios/Acme.xcodeproj/project.pbxproj': 'PRODUCT_BUNDLE_IDENTIFIER = io.acme.app.dev;',
  };

  it('never asks a question with --yes, even when it has to fail', async () => {
    // An empty script throws on ANY question, so an empty `asked` proves both
    // that nothing was asked and that nothing was silently defaulted.
    const prompts = scriptedPrompter({});
    const boundary = unattended({ cwd: '/w', files: detected });
    await runInit(boundary, { cwd: '/w', yes: true }, { prompts }).catch(() => undefined);
    expect(prompts.asked).toEqual([]);
  });

  /** Every answer supplied, so the run reaches the write step with nothing missing. */
  const fullFlags = {
    cwd: '/w',
    iosDir: 'ios',
    xcodeproj: 'Acme.xcodeproj',
    scheme: 'Acme',
    teamId: 'ABCDE12345',
    bundleId: 'io.acme.app.dev',
    displayName: 'Acme Dev',
  };

  it('fails naming --yes when there is no terminal and no --yes', async () => {
    // Everything is answered, so the only thing left to ask is "write this?" —
    // and without a terminal that consent has to come from the flag.
    const prompts = scriptedPrompter({});
    const boundary = unattended({ cwd: '/w', files: detected });
    const error = await runInit(boundary, fullFlags, { prompts }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(JetbridgeError);
    expect((error as Error).message).toMatch(/re-run with --yes/);
    expect(prompts.asked).toEqual([]);
    expect(boundary.writes).toEqual([]);
  });

  it('writes the file with --yes and no terminal at all', async () => {
    const prompts = scriptedPrompter({});
    const boundary = unattended({ cwd: '/w', files: detected });
    const result = await runInit(boundary, { ...fullFlags, yes: true }, { prompts });
    expect(result.status).toBe('written');
    expect(prompts.asked).toEqual([]);
  });

  it('names the flag for each value it could not work out', async () => {
    const boundary = unattended({ cwd: '/empty' });
    const error = await runInit(
      boundary,
      { cwd: '/empty', yes: true },
      { prompts: scriptedPrompter({}) },
    ).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/there is nobody to ask/);
    expect((error as Error).message).toMatch(/--scheme|--team-id|--bundle-id|--xcodeproj/);
  });

  it('does not prompt on the repair path either', async () => {
    const prompts = scriptedPrompter({});
    const boundary = unattended({
      cwd: '/w',
      files: {
        ...detected,
        '/w/jetbridge.config.json': JSON.stringify({
          configVersion: 1,
          project: {
            iosDir: 'ios',
            xcodeproj: 'Acme.xcodeproj',
            scheme: 'Acme',
            teamId: 'ABCDE12345',
            baseBundleId: 'io.acme.app.dev',
          },
          variant: { displayName: 'Acme Dev' },
        }),
      },
    });
    await runInit(boundary, { cwd: '/w' }, { prompts }).catch(() => undefined);
    expect(prompts.asked).toEqual([]);
  });

  it('still shows what it would write, because a note is not a question', async () => {
    const prompts = scriptedPrompter({});
    const boundary = unattended({ cwd: '/w', files: detected });
    await runInit(boundary, { ...fullFlags, yes: true }, { prompts });
    expect(prompts.notes.length).toBeGreaterThan(0);
  });
});

describe('every command entry point', () => {
  /** Each is called with nothing stubbed: the only wrong answer is to wait. */
  const entryPoints: Array<[string, () => Promise<unknown>]> = [
    ['wiredInstall', () => wiredInstall(unattended(), project, { suffix: '', displayName: 'A' })],
    ['simInstall', () => simInstall(unattended(), project, { suffix: '', displayName: 'A' })],
    ['otaInstall', () => otaInstall(unattended(), project, { suffix: '', displayName: 'A' })],
    ['reindex', () => reindex(unattended(), project, {})],
    ['pruneBundles', () => pruneBundles(unattended(), project, {})],
    ['removeBundles', () => removeBundles(unattended(), project, { suffixes: ['wave'] })],
    [
      'runInit',
      () =>
        runInit(
          unattended({ cwd: '/w' }),
          { cwd: '/w', yes: true },
          { prompts: scriptedPrompter({}) },
        ),
    ],
  ];

  for (const [name, run] of entryPoints) {
    it(
      `${name} settles rather than waiting for a person`,
      async () => {
        const outcome = await run().then(
          () => 'resolved',
          (error: unknown) => error,
        );
        if (outcome === 'resolved') return;
        // A failure is a fine outcome — an explained one, not a stack.
        expect(outcome).toBeInstanceOf(JetbridgeError);
        expect((outcome as Error).message).not.toBe('');
      },
      // The assertions cannot catch a wait, so the budget does: a hang here
      // fails as a timeout instead of stalling the whole suite.
      HANG_BUDGET_MS,
    );
  }
});

describe('a child process cannot hang on stdin', () => {
  /**
   * The real boundary, not the fake — the fake spawns nothing, so it can never
   * prove this. `read` blocks until it gets a line, which is what a hook or a
   * tool that decides to ask a question does.
   *
   * Verified against the old behaviour before the fix: `stdio: 'pipe'` with no
   * input never returned, because execa leaves the child's stdin pipe open.
   */
  const READS_STDIN = 'read -r answer; echo "got:$answer"';

  it(
    'a captured child reads EOF instead of waiting forever',
    async () => {
      const boundary = nodeBoundary();
      const result = await boundary.exec.run('/bin/sh', ['-c', READS_STDIN]);
      expect(result.stdout).toBe('got:');
    },
    HANG_BUDGET_MS,
  );

  it(
    'a child streaming its output to the terminal cannot wait either',
    async () => {
      // What `runHook` does: `stdio: 'inherit'` for live output. Unattended, that
      // must not also hand over stdin.
      const boundary = nodeBoundary({ nonInteractive: true });
      const result = await boundary.exec.run('/bin/sh', ['-c', READS_STDIN], { stdio: 'inherit' });
      expect(result.code).toBe(0);
    },
    HANG_BUDGET_MS,
  );

  it(
    'the synchronous form is safe too',
    () => {
      const boundary = nodeBoundary();
      expect(boundary.exec.runSync('/bin/sh', ['-c', READS_STDIN]).stdout).toBe('got:');
    },
    HANG_BUDGET_MS,
  );

  it(
    'still delivers input when the caller has some',
    async () => {
      const boundary = nodeBoundary();
      const result = await boundary.exec.run('/bin/sh', ['-c', READS_STDIN], { input: 'hello\n' });
      expect(result.stdout).toBe('got:hello');
    },
    HANG_BUDGET_MS,
  );
});

describe('the prompter refuses rather than hangs', () => {
  it('clackPrompter hands back the refusing prompter with no terminal', async () => {
    const prompter = withTty(false, () => clackPrompter());
    await expect(prompter.confirm({ name: 'write', message: 'Write it?' })).rejects.toThrow(
      JetbridgeError,
    );
  });

  it('names the question, so the caller knows which flag is missing', async () => {
    const prompter = nonInteractivePrompter('this run has no terminal to ask on');
    await expect(
      prompter.text({ name: 'project.scheme', message: 'Scheme to build' }),
    ).rejects.toThrow(/Scheme to build.*\n.*project\.scheme/s);
  });

  it('refuses every kind of question', async () => {
    const prompter = nonInteractivePrompter('nobody is there');
    await expect(prompter.text({ name: 'a', message: 'A?' })).rejects.toThrow(JetbridgeError);
    await expect(prompter.confirm({ name: 'b', message: 'B?' })).rejects.toThrow(JetbridgeError);
    await expect(
      prompter.select({ name: 'c', message: 'C?', options: [{ value: 'x' }] }),
    ).rejects.toThrow(JetbridgeError);
  });

  it('still prints a note, which the --yes dry run depends on', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      nonInteractivePrompter('nobody is there').note('the config', '/w/jetbridge.config.json');
      expect(spy).toHaveBeenCalledWith('/w/jetbridge.config.json\nthe config');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the scripted prompter is a trap for an unexpected question', () => {
  it('throws when asked something the script does not carry', async () => {
    // Without this, a wizard that grows a question would silently default it
    // and every test above would keep passing.
    await expect(
      scriptedPrompter({}).confirm({ name: 'write', message: 'Write it?' }),
    ).rejects.toThrow(/the wizard asked "write".*and the script has no answer/);
  });

  it('records what it was asked, so a test can assert nothing was', async () => {
    const prompts = scriptedPrompter({ write: true });
    await prompts.confirm({ name: 'write', message: 'Write it?' });
    expect(prompts.asked).toEqual(['write']);
  });
});
