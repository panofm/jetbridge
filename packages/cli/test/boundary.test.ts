/**
 * The boundary is the one place jetbridge touches the outside world, and every
 * other suite in this repo asserts against a fake of it. So the real thing is
 * pinned here — and the filesystem contract both halves have to satisfy is
 * written ONCE and run against both, because a fake that has quietly drifted
 * turns the rest of the suite into fiction.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isInteractive,
  nodeBoundary,
  nodeFileSystem,
  nodeReporter,
  type FileSystem,
} from '../src/boundary.js';
import { fakeBoundary } from './helpers/fake-boundary.js';

const boundary = nodeBoundary();

describe('exec.run', () => {
  it('captures stdout and a zero exit code', async () => {
    const result = await boundary.exec.run('echo', ['hello']);
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('hello');
    expect(result.stderr).toBe('');
  });

  it('returns a failing result instead of throwing on a non-zero exit', async () => {
    // Every caller in jetbridge reads `result.ok` and writes its own message; a
    // throw here would bypass all of them.
    const result = await boundary.exec.run('sh', ['-c', 'exit 3']);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(3);
  });

  it('captures stderr separately from stdout', async () => {
    const result = await boundary.exec.run('sh', ['-c', 'echo out; echo err >&2']);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
  });

  it('honours the cwd option', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jetbridge-cwd-')));
    try {
      const result = await boundary.exec.run('pwd', [], { cwd: dir });
      expect(result.stdout).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honours the env option, and still extends the inherited environment', async () => {
    const result = await boundary.exec.run('sh', ['-c', 'echo "$JETBRIDGE_PROBE"; echo "$PATH"'], {
      env: { JETBRIDGE_PROBE: 'set-by-test' },
    });
    const [probe, path] = result.stdout.split('\n');
    expect(probe).toBe('set-by-test');
    expect(path).not.toBe('');
  });

  it('feeds the input option to the child on stdin', async () => {
    const result = await boundary.exec.run('cat', [], { input: 'from stdin' });
    expect(result.stdout).toBe('from stdin');
  });

  it('does not reject when the binary cannot be spawned at all', async () => {
    // Only the no-throw half is asserted. What `ok` should be for a spawn
    // failure is a live defect — see the note in the divergences block below.
    await expect(boundary.exec.run('jetbridge-no-such-binary', [])).resolves.toBeDefined();
  });
});

describe('exec.runSync', () => {
  it('captures stdout and a zero exit code', () => {
    const result = boundary.exec.runSync('echo', ['hello']);
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('hello');
  });

  it('returns a failing result instead of throwing on a non-zero exit', () => {
    const result = boundary.exec.runSync('sh', ['-c', 'exit 3']);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(3);
  });

  it('captures stderr, and honours cwd, env and input like the async form', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jetbridge-sync-')));
    try {
      expect(boundary.exec.runSync('sh', ['-c', 'echo err >&2']).stderr).toBe('err');
      expect(boundary.exec.runSync('pwd', [], { cwd: dir }).stdout).toBe(dir);
      expect(
        boundary.exec.runSync('sh', ['-c', 'echo "$JETBRIDGE_PROBE"'], {
          env: { JETBRIDGE_PROBE: 'sync' },
        }).stdout,
      ).toBe('sync');
      expect(boundary.exec.runSync('cat', [], { input: 'sync stdin' }).stdout).toBe('sync stdin');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('now', () => {
  it('returns unix SECONDS, not milliseconds', () => {
    // A build number is this value. Milliseconds would still increase, so the
    // mistake is invisible — until a later build number is smaller than an
    // earlier one and iOS declines to replace the app.
    const seconds = boundary.now();
    expect(seconds).toBe(Math.floor(seconds));
    expect(Math.abs(seconds - Date.now() / 1000)).toBeLessThan(5);
    expect(seconds).toBeLessThan(1e11);
  });
});

describe('env, homedir and cwd', () => {
  it('reads a variable out of the process environment', () => {
    expect(boundary.env('PATH')).toBe(process.env.PATH);
  });

  it('is undefined for a variable that is not set', () => {
    expect(boundary.env('JETBRIDGE_DEFINITELY_NOT_SET')).toBeUndefined();
  });

  it('reports the home and working directories', () => {
    expect(boundary.homedir()).toBe(process.env.HOME ?? '');
    expect(boundary.cwd()).toBe(process.cwd());
  });
});

describe('isInteractive', () => {
  /** Both halves are read off the real streams, so they are stubbed and restored. */
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

  it('is true on a terminal with no CI variable', () => {
    expect(withTty(true, () => isInteractive({}))).toBe(true);
  });

  it('is false when CI is set, even on a terminal', () => {
    // `CI=1` on a developer's machine is the documented way to force the
    // non-interactive path, so this must beat a real TTY.
    expect(withTty(true, () => isInteractive({ CI: '1' }))).toBe(false);
    expect(withTty(true, () => isInteractive({ CI: 'true' }))).toBe(false);
  });

  it('is false without a terminal, whatever the environment says', () => {
    expect(withTty(false, () => isInteractive({}))).toBe(false);
    expect(withTty(false, () => isInteractive({ CI: '1' }))).toBe(false);
  });

  it('treats an empty CI value as unset', () => {
    expect(withTty(true, () => isInteractive({ CI: '' }))).toBe(true);
  });

  it('is false whenever the reporter is in --json mode, terminal or not', () => {
    // A caller asking for machine output is a machine. A prompt would draw its
    // frames on stdout, which is the one stream that has to stay parseable.
    expect(
      withTty(true, () => nodeBoundary({ reporter: nodeReporter({ json: true }) }).interactive),
    ).toBe(false);
    expect(withTty(true, () => nodeBoundary().interactive)).toBe(true);
  });
});

interface FsFixture {
  fs: FileSystem;
  root: string;
  cleanup: () => void;
}

/**
 * One filesystem contract, run against the real implementation and against the
 * in-memory fake. A divergence in anything the suite relies on fails here
 * instead of silently invalidating every other test file.
 */
function filesystemContract(label: string, setup: () => FsFixture): void {
  describe(`filesystem contract — ${label}`, () => {
    let fs: FileSystem;
    let root: string;
    let cleanup: () => void;

    beforeEach(() => {
      ({ fs, root, cleanup } = setup());
    });
    afterEach(() => cleanup());

    const at = (...segments: string[]): string => join(root, ...segments);

    it('round-trips text', () => {
      fs.write(at('note.txt'), 'hello');
      expect(fs.exists(at('note.txt'))).toBe(true);
      expect(fs.read(at('note.txt'))).toBe('hello');
    });

    it('round-trips bytes', () => {
      const bytes = new Uint8Array([0x00, 0x7f, 0x80, 0xff]);
      fs.write(at('blob.bin'), bytes);
      expect([...fs.readBytes(at('blob.bin'))]).toEqual([...bytes]);
    });

    it('overwrites an existing file', () => {
      fs.write(at('note.txt'), 'first');
      fs.write(at('note.txt'), 'second');
      expect(fs.read(at('note.txt'))).toBe('second');
    });

    it('creates missing parent directories on write', () => {
      // Profiles and backups are written to paths nobody created first.
      fs.write(at('a', 'b', 'c.txt'), 'deep');
      expect(fs.read(at('a', 'b', 'c.txt'))).toBe('deep');
      expect(fs.exists(at('a', 'b'))).toBe(true);
      expect(fs.isDirectory(at('a', 'b'))).toBe(true);
    });

    it('makes directories idempotently', () => {
      fs.mkdirp(at('x', 'y'));
      fs.mkdirp(at('x', 'y'));
      expect(fs.isDirectory(at('x', 'y'))).toBe(true);
    });

    it('lists one level of a directory', () => {
      fs.write(at('list', 'one.txt'), '1');
      fs.write(at('list', 'two.txt'), '2');
      fs.write(at('list', 'nested', 'three.txt'), '3');
      expect([...fs.readdir(at('list'))].sort()).toEqual(['nested', 'one.txt', 'two.txt']);
    });

    it('removes a whole tree recursively', () => {
      fs.write(at('tree', 'deep', 'file.txt'), 'x');
      fs.rm(at('tree'), { recursive: true });
      expect(fs.exists(at('tree'))).toBe(false);
      expect(fs.exists(at('tree', 'deep', 'file.txt'))).toBe(false);
    });

    it('removes a single file', () => {
      fs.write(at('gone.txt'), 'x');
      fs.rm(at('gone.txt'));
      expect(fs.exists(at('gone.txt'))).toBe(false);
    });

    it('removing a missing path is not an error', () => {
      expect(() => fs.rm(at('never-existed.txt'))).not.toThrow();
    });

    it('throws when reading a file that is not there', () => {
      expect(() => fs.read(at('absent.txt'))).toThrow();
      expect(() => fs.readBytes(at('absent.txt'))).toThrow();
    });

    it('says false for a path that does not exist', () => {
      expect(fs.exists(at('absent.txt'))).toBe(false);
      expect(fs.isDirectory(at('absent.txt'))).toBe(false);
    });

    it('distinguishes a file from a directory', () => {
      fs.write(at('dir', 'file.txt'), 'x');
      expect(fs.isDirectory(at('dir'))).toBe(true);
      expect(fs.isDirectory(at('dir', 'file.txt'))).toBe(false);
      expect(fs.exists(at('dir', 'file.txt'))).toBe(true);
    });

    it('reports size in bytes, not characters', () => {
      fs.write(at('utf8.txt'), 'héllo');
      expect(fs.size(at('utf8.txt'))).toBe(6);
    });
  });
}

filesystemContract('the real filesystem', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jetbridge-fs-')));
  return {
    fs: nodeFileSystem,
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
});

filesystemContract('the in-memory fake', () => {
  const fake = fakeBoundary({ cwd: '/root' });
  fake.fs.mkdirp('/root');
  return { fs: fake.fs, root: '/root', cleanup: () => {} };
});

describe('a spawn failure is reported as success', () => {
  /**
   * NOT a pinned contract — a defect, recorded so it is not lost. `asResult`
   * coalesces a missing `exitCode` to 0, and execa leaves `exitCode` undefined
   * when the process never started (ENOENT, EACCES). So an uninstalled tool
   * comes back `ok: true` with empty output, and the caller carries on as if it
   * had run. The fake has no equivalent path: an unstubbed command is code 127.
   */
  it('is what happens today, for both the async and the sync form', async () => {
    expect((await boundary.exec.run('jetbridge-no-such-binary', [])).ok).toBe(true);
    expect(boundary.exec.runSync('jetbridge-no-such-binary', []).ok).toBe(true);
    expect((await boundary.exec.run('jetbridge-no-such-binary', [])).code).toBeNull();
  });
});

describe('known divergences between the real filesystem and the fake', () => {
  /**
   * Pinned rather than fixed: nothing in jetbridge does either of these, and a
   * test that names them is what stops a future caller assuming they match.
   */
  it('readdir on a missing directory throws for real and returns empty for the fake', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'jetbridge-div-')));
    try {
      expect(() => nodeFileSystem.readdir(join(root, 'missing'))).toThrow(/ENOENT/);
      expect(fakeBoundary({ cwd: '/root' }).fs.readdir('/root/missing')).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a non-recursive rm of a directory throws for real and is silent for the fake', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'jetbridge-div-')));
    try {
      nodeFileSystem.write(join(root, 'dir', 'file.txt'), 'x');
      expect(() => nodeFileSystem.rm(join(root, 'dir'))).toThrow();

      const fake = fakeBoundary({ cwd: '/root' });
      fake.fs.write('/root/dir/file.txt', 'x');
      expect(() => fake.fs.rm('/root/dir')).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
