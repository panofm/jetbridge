/**
 * Two channels, one run.
 *
 * The reporter is the tool's front door: it is what a person watches for the
 * minutes a build takes, and it is the whole of what an agent parses. Both are
 * pinned here — the human side through a captured pair of sinks and a clock the
 * test moves by hand, and the machine side through a real `install` driven end
 * to end against the fake boundary.
 */
import { describe, expect, it } from 'vitest';
import { createReporter, formatDuration, type Reporter } from '../src/reporter.js';
import type { DevicectlDevice } from '../src/devices.js';
import { projectFrom, type Project } from '../src/project.js';
import { wiredInstall } from '../src/wired.js';
import { testConfig } from './helpers/config.js';
import {
  fakeBoundary,
  type FakeBoundary,
  type FakeBoundaryOptions,
} from './helpers/fake-boundary.js';

/** Chalk colours when the test runner happens to have a terminal. */
// eslint-disable-next-line no-control-regex
const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

/**
 * What a terminal would actually show: an erase sequence wipes whatever was
 * drawn before it, so only the text after the LAST erase on a line survives.
 */
const visible = (raw: string): string[] =>
  raw
    .split('\n')
    .map((row) => plain(row.split('\r\u001b[2K').at(-1)!))
    .slice(0, -1);

interface Harness {
  reporter: Reporter;
  stdout: string[];
  stderr: string[];
  advance(ms: number): void;
  human(): string;
  events(): Array<Record<string, unknown>>;
}

function harness(options: { tty?: boolean; json?: boolean } = {}): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let elapsed = 0;
  return {
    stdout,
    stderr,
    advance: (ms) => {
      elapsed += ms;
    },
    human: () => plain(stderr.join('')),
    events: () =>
      stdout
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    reporter: createReporter({
      out: (text) => stdout.push(text),
      err: (text) => stderr.push(text),
      elapsedMs: () => elapsed,
      tty: options.tty ?? false,
      json: options.json ?? false,
    }),
  };
}

describe('formatDuration', () => {
  it('keeps one decimal below a second, so a fast step is not "0s"', () => {
    expect(formatDuration(0)).toBe('0.0s');
    expect(formatDuration(300)).toBe('0.3s');
    expect(formatDuration(999)).toBe('1.0s');
  });

  it('drops to whole seconds once there is a second to show', () => {
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(18_400)).toBe('18s');
    expect(formatDuration(59_400)).toBe('59s');
  });

  it('rolls over into minutes rather than printing "60s"', () => {
    // The rounding happens once, before the split. Rounding after it prints 60s
    // for anything from 59.5 seconds up.
    expect(formatDuration(59_600)).toBe('1m');
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(72_000)).toBe('1m 12s');
    expect(formatDuration(113_000)).toBe('1m 53s');
    expect(formatDuration(120_000)).toBe('2m');
  });
});

describe('the human channel', () => {
  it('puts the header up before a single step runs', () => {
    const h = harness();
    h.reporter.start({
      command: 'install',
      title: ['Acme Wave', 'io.acme.app.dev.wave', 'Debug'],
      rows: [
        { label: 'devices', text: "Dev's 17 Pro" },
        { label: 'signing', text: 'reusing Acme wave app' },
      ],
    });
    const beforeAnyStep = h.human();
    expect(beforeAnyStep).toContain('Acme Wave  ·  io.acme.app.dev.wave  ·  Debug');
    expect(beforeAnyStep).toContain("  devices   Dev's 17 Pro");
    expect(beforeAnyStep).toContain('  signing   reusing Acme wave app');
    expect(beforeAnyStep).not.toContain('✓');
  });

  it('reports a step with its duration and its detail', () => {
    const h = harness();
    const step = h.reporter.begin('build', 'built');
    step.detail('build 1786437647 (shown in Settings › App Info)');
    h.advance(72_000);
    step.ok();
    expect(h.human()).toContain(
      '✓ built                1m 12s   build 1786437647 (shown in Settings › App Info)',
    );
  });

  it('marks a failed step with ✗ and still says how long it took', () => {
    const h = harness();
    const step = h.reporter.begin('install', "Dev's XS");
    h.advance(4_000);
    step.fail();
    expect(h.human()).toContain("✗ Dev's XS");
    expect(h.human()).toContain('4s');
  });

  it('closes with a total measured from the header', () => {
    const h = harness();
    h.reporter.start({ command: 'install', title: ['Acme Dev'] });
    h.advance(113_000);
    h.reporter.done();
    expect(h.human()).toContain('done in 1m 53s');
  });

  it('says nothing more after a failure — the ✗ line already ended the run', () => {
    const h = harness();
    h.reporter.error('no paired device is reachable');
    h.reporter.done(false);
    expect(h.human()).toBe('✗ no paired device is reachable\n');
  });
});

describe('a terminal, and everything else', () => {
  it('announces a step as it starts, then rewrites the line, on a TTY', () => {
    const h = harness({ tty: true });
    const step = h.reporter.begin('build', 'built');
    // The line is on screen while the build runs: this is what stops minutes of
    // silence reading as a hang.
    expect(h.stderr.join('')).toContain('built');
    expect(h.stderr.join('')).not.toContain('\n');
    h.advance(1_000);
    step.ok();
    expect(h.stderr.join('')).toContain('\u001b[2K');
    expect(h.human().trimEnd().split('\n')).toHaveLength(1);
  });

  it('writes one plain line per step without a terminal, and no escapes at all', () => {
    const h = harness();
    const step = h.reporter.begin('build', 'built');
    // Nothing at all until it finishes: a half-written line in a log file is
    // noise, and the escape that would rewrite it is worse.
    expect(h.stderr).toEqual([]);
    h.advance(1_000);
    step.ok();
    expect(h.stderr.join('')).not.toContain('\u001b[');
    expect(h.human().trimEnd().split('\n')).toHaveLength(1);
  });

  it('keeps a finished line above the one still running', () => {
    const h = harness({ tty: true });
    const step = h.reporter.begin('build', 'built');
    h.reporter.warn('the working tree is dirty');
    expect(h.human()).toContain('the working tree is dirty\n');
    step.ok();
    const lines = h.human().trimEnd().split('\n');
    expect(plain(lines.at(-1)!)).toContain('✓ built');
  });
});

describe('a message logged while a step is running', () => {
  it("never lands on the step's own line, and reads as a sub-line under it", () => {
    const h = harness({ tty: true });
    const step = h.reporter.begin('provision', 'provisioned');
    h.reporter.note('provisioning io.acme.app.dev.wave');
    h.reporter.note('provisioning io.acme.app.dev.wave.uploadwidget');
    h.advance(3_000);
    step.fail();

    // The defect this pins: `· provisionedprovisioning io.acme…` on one line.
    // The pending line has to be erased before the message and redrawn after.
    expect(visible(h.stderr.join(''))).toEqual([
      '    provisioning io.acme.app.dev.wave',
      '    provisioning io.acme.app.dev.wave.uploadwidget',
      '  ✗ provisioned          3s',
    ]);
  });

  it('degrades to plain sequential lines, with no escape codes, without a TTY', () => {
    const h = harness();
    const step = h.reporter.begin('provision', 'provisioned');
    h.reporter.note('provisioning io.acme.app.dev.wave');
    h.advance(3_000);
    step.ok();
    expect(h.stderr.join('')).not.toContain('[');
    expect(h.human()).toBe('    provisioning io.acme.app.dev.wave\n  ✓ provisioned          3s\n');
  });

  it('goes back to the left margin once the step is over', () => {
    const h = harness();
    h.reporter.begin('build', 'built').ok();
    h.reporter.note('a message that belongs to nothing');
    expect(h.human()).toContain('\na message that belongs to nothing\n');
  });
});

describe('the label column', () => {
  it('widens once to the labels the run declares, so no row is out of line', () => {
    const h = harness();
    h.reporter.start({
      command: 'install',
      title: ['Acme Dev'],
      labels: ['built', 'a-simulator-with-a-long-name'],
    });
    h.reporter.begin('build', 'built').ok();
    h.reporter.begin('install', 'a-simulator-with-a-long-name').ok();

    const rows = h.human().trimEnd().split('\n').slice(-2);
    // The duration starts at the same column on both, which is the whole point.
    expect(rows[0]!.indexOf('0.0s')).toBe(rows[1]!.indexOf('0.0s'));
    expect(rows[0]).toContain('✓ built ');
  });

  it('truncates a label nobody declared rather than pushing the column', () => {
    const h = harness();
    h.reporter.start({ command: 'install', title: ['Acme Dev'] });
    h.reporter.begin('build', 'built').ok();
    h.reporter.begin('install', 'an-undeclared-simulator-name').ok();

    const rows = h.human().trimEnd().split('\n').slice(-2);
    expect(rows[1]).toContain('an-undeclared-simul…');
    expect(rows[0]!.indexOf('0.0s')).toBe(rows[1]!.indexOf('0.0s'));
  });

  it("never lets one run's width leak into the next", () => {
    const h = harness();
    h.reporter.start({ command: 'install', title: ['x'], labels: ['a-very-long-device-name'] });
    h.reporter.start({ command: 'install', title: ['x'] });
    h.reporter.begin('build', 'built').ok();
    expect(h.human()).toContain('✓ built                0.0s');
  });
});

describe('--json', () => {
  it('puts nothing on stdout without it', () => {
    const h = harness();
    h.reporter.start({ command: 'install', title: ['Acme Dev'] });
    h.reporter.begin('build', 'built').ok();
    h.reporter.done();
    expect(h.stdout).toEqual([]);
    expect(h.human()).not.toBe('');
  });

  it('puts one parseable object per line on stdout, and every human line on stderr', () => {
    const h = harness({ json: true });
    h.reporter.start({
      command: 'install',
      data: { bundleId: 'io.acme.app.dev.wave' },
      title: ['Acme Wave'],
      rows: [{ label: 'devices', text: "Dev's 17 Pro", event: 'devices', data: { count: 1 } }],
    });
    h.reporter.note('an aside for the person watching');
    h.advance(500);
    h.reporter.done();

    for (const chunk of h.stdout) expect(chunk.endsWith('\n')).toBe(true);
    expect(h.events()).toEqual([
      { event: 'start', command: 'install', bundleId: 'io.acme.app.dev.wave' },
      { event: 'devices', count: 1 },
      { event: 'done', ok: true, durationMs: 500 },
    ]);
    expect(h.human()).toContain('an aside for the person watching');
    expect(h.stdout.join('')).not.toContain('an aside');
  });

  it('emits an error event before the done that closes the stream', () => {
    const h = harness({ json: true });
    h.reporter.error('xcodebuild failed');
    h.reporter.done(false);
    expect(h.events()).toEqual([
      { event: 'error', message: 'xcodebuild failed' },
      { event: 'done', ok: false, durationMs: 0 },
    ]);
  });
});

// ─── the whole of `install --device`, both channels at once ──────────────────

const HOME = '/home/dev';
const DERIVED_DATA = `${HOME}/Library/Caches/jetbridge/default`;
const APP_PATH = `${DERIVED_DATA}/Build/Products/Debug-iphoneos/Acme.app`;

const project: Project = projectFrom('/w/jetbridge.config.json', testConfig());

const device = (id: string, name: string, transport = 'wired'): DevicectlDevice => ({
  identifier: id,
  deviceProperties: { name },
  hardwareProperties: { deviceType: 'iPhone', udid: `UDID-${id}` },
  connectionProperties: { transportType: transport, pairingState: 'paired' },
});

/** Every stubbed command carries how long it "takes", so durations are exact. */
function installBoundary(devices: DevicectlDevice[], over: FakeBoundaryOptions = {}): FakeBoundary {
  const boundary = fakeBoundary({
    homedir: HOME,
    files: { '/w/ios/Acme.xcodeproj/project.pbxproj': '// project' },
    commands: [
      { match: ['command', '-v'] },
      { match: ['xcrun', 'devicectl', 'list', 'devices'] },
      { match: ['xcodebuild', 'build'], durationMs: 72_000 },
      ...devices.map((d, index) => ({
        match: ['devicectl', 'device', 'install', 'app', '--device', d.identifier!],
        durationMs: 18_000 + index * 4_000,
      })),
    ],
    ...over,
  });
  const inner = boundary.exec.run;
  boundary.exec.run = async (command, args, opts) => {
    const result = await inner(command, args, opts);
    const at = args.indexOf('--json-output');
    if (command === 'xcrun' && at !== -1) {
      boundary.fs.write(args[at + 1]!, JSON.stringify({ result: { devices } }));
    }
    if (command === 'xcodebuild' && result.ok) boundary.fs.write(APP_PATH, 'MACH-O');
    return result;
  };
  return boundary;
}

const plainVariant = { suffix: '', displayName: 'Acme Dev' };

describe('an install, reported', () => {
  it('reads as the target output — header, timed steps, total', async () => {
    const boundary = installBoundary([device('DEV-A', "Dev's 17 Pro")]);
    await wiredInstall(boundary, project, plainVariant);
    const printed = plain(boundary.humanOutput());
    expect(printed).toContain('Acme Dev  ·  io.acme.app.dev  ·  Debug');
    expect(printed).toContain("  devices   Dev's 17 Pro");
    expect(printed).toContain("the project's own signing, untouched");
    expect(printed).toContain('build 1700000000 (shown in Settings › App Info)');
    expect(printed).toMatch(/✓ built {16}1m 12s/);
    expect(printed).toMatch(/✓ Dev's 17 Pro {9}18s/);
    expect(printed).toContain('done in 1m 30s');
  });

  it('names the Wi-Fi devices in the header, where cabling them still helps', async () => {
    const boundary = installBoundary([
      device('DEV-A', "Dev's 17 Pro", 'localNetwork'),
      device('DEV-B', "Dev's XS", 'localNetwork'),
    ]);
    await wiredInstall(boundary, project, plainVariant);
    expect(plain(boundary.humanOutput())).toContain(
      "Dev's 17 Pro, Dev's XS  (both over Wi-Fi — cable them for the fast loop)",
    );
  });

  it('emits the whole event sequence, in order, with nothing else on stdout', async () => {
    const boundary = installBoundary([device('DEV-A', "Dev's 17 Pro")], { json: true });
    await wiredInstall(boundary, project, plainVariant);

    const events = boundary.events();
    expect(events.map((event) => event.event)).toEqual([
      'start',
      'devices',
      'signing',
      'step',
      'step',
      'step',
      'step',
      'done',
    ]);
    expect(events[0]).toEqual({
      event: 'start',
      command: 'install',
      destination: 'device',
      bundleId: 'io.acme.app.dev',
      displayName: 'Acme Dev',
      configuration: 'Debug',
      suffix: '',
    });
    expect(events[1]).toEqual({
      event: 'devices',
      devices: [{ id: 'DEV-A', name: "Dev's 17 Pro", udid: 'UDID-DEV-A', transport: 'wired' }],
    });
    expect(events[2]).toEqual({ event: 'signing', decision: 'project', profiles: [] });
    expect(events[3]).toEqual({ event: 'step', step: 'build', phase: 'start' });
    expect(events[4]).toMatchObject({
      event: 'step',
      step: 'build',
      phase: 'end',
      ok: true,
      durationMs: 72_000,
      buildNumber: '1700000000',
    });
    expect(events[6]).toMatchObject({
      event: 'step',
      step: 'install',
      phase: 'end',
      ok: true,
      durationMs: 18_000,
      device: { id: 'DEV-A', name: "Dev's 17 Pro" },
      bundleId: 'io.acme.app.dev',
    });
    expect(events.at(-1)).toMatchObject({ event: 'done', ok: true, durationMs: 90_000 });
  });

  it('keeps stdout parseable line by line while the person reads stderr', async () => {
    const boundary = installBoundary([device('DEV-A', "Dev's 17 Pro")], { json: true });
    await wiredInstall(boundary, project, plainVariant);

    const text = boundary.stdout.join('');
    expect(text.endsWith('\n')).toBe(true);
    for (const line of text.split('\n').filter(Boolean)) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
    // Not a colour code, not a spinner frame, not a stray log line.
    expect(text).not.toContain('\u001b[');
    expect(text).not.toContain('✓');
    expect(plain(boundary.humanOutput())).toContain('✓ built');
  });

  it('marks the device that refused the install, and the run fails', async () => {
    const boundary = installBoundary([device('DEV-A', "Dev's 17 Pro")], {
      json: true,
      commands: [
        { match: ['command', '-v'] },
        { match: ['xcrun', 'devicectl', 'list', 'devices'] },
        { match: ['xcodebuild', 'build'], durationMs: 72_000 },
        { match: ['devicectl', 'device', 'install'], durationMs: 3_000, code: 1 },
      ],
    });
    await expect(wiredInstall(boundary, project, plainVariant)).rejects.toThrow(
      /1 of 1 installs failed/,
    );
    expect(plain(boundary.humanOutput())).toMatch(/✗ Dev's 17 Pro {9}3s/);
    expect(boundary.events().at(-1)).toMatchObject({
      event: 'step',
      step: 'install',
      ok: false,
      durationMs: 3_000,
    });
  });
});
