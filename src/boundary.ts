/**
 * Everything this tool does to the outside world goes through one object.
 *
 * Nearly every line of jetbridge shells out (`xcodebuild`, `devicectl`,
 * `simctl`, `security`, `git`), calls App Store Connect, or writes to a bucket.
 * Called inline, none of it is exercisable without a Mac, a paired iPhone, an
 * Apple team and a bucket — so it is threaded as one parameter instead, with
 * the real implementation as the default. Tests pass a fake and assert the
 * argv arrays.
 *
 * This is a parameter, not a framework: no container, no registry, no
 * decorators.
 */
import { execa, execaSync } from 'execa';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Stream the child's output to the terminal instead of capturing it. */
  stdio?: 'pipe' | 'inherit';
  /** Return a failed result instead of throwing. */
  allowFail?: boolean;
  input?: string;
  timeoutMs?: number;
}

export interface CommandResult {
  ok: boolean;
  /** null when the process was killed by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** A command as it was invoked — what tests assert against. */
export interface CommandCall {
  command: string;
  args: string[];
  options: RunOptions;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text: () => Promise<string>;
  json: <T = unknown>() => Promise<T>;
}

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface FileSystem {
  exists(path: string): boolean;
  read(path: string): string;
  readBytes(path: string): Uint8Array;
  write(path: string, contents: string | Uint8Array): void;
  mkdirp(path: string): void;
  readdir(path: string): string[];
  rm(path: string, opts?: { recursive?: boolean }): void;
  isDirectory(path: string): boolean;
  size(path: string): number;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Progress that is noise in a log file — suppressed when not a TTY. */
  step(message: string): void;
}

export interface Boundary {
  exec: {
    run(command: string, args: string[], options?: RunOptions): Promise<CommandResult>;
    runSync(command: string, args: string[], options?: RunOptions): CommandResult;
  };
  fs: FileSystem;
  http(request: HttpRequest): Promise<HttpResponse>;
  env(name: string): string | undefined;
  /** Unix seconds. Injected because build numbers are derived from it. */
  now(): number;
  homedir(): string;
  cwd(): string;
  log: Logger;
  /** False behind a pipe or in CI: never prompt, never expect a terminal. */
  interactive: boolean;
}

const asResult = (r: {
  exitCode?: number | undefined;
  stdout?: unknown;
  stderr?: unknown;
}): CommandResult => ({
  ok: (r.exitCode ?? 0) === 0,
  code: r.exitCode ?? null,
  stdout: typeof r.stdout === 'string' ? r.stdout : '',
  stderr: typeof r.stderr === 'string' ? r.stderr : '',
});

export const nodeFileSystem: FileSystem = {
  exists: (path) => existsSync(path),
  read: (path) => readFileSync(path, 'utf8'),
  readBytes: (path) => new Uint8Array(readFileSync(path)),
  write: (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  },
  mkdirp: (path) => {
    mkdirSync(path, { recursive: true });
  },
  readdir: (path) => readdirSync(path),
  rm: (path, opts) => {
    rmSync(path, { recursive: opts?.recursive ?? false, force: true });
  },
  isDirectory: (path) => existsSync(path) && statSync(path).isDirectory(),
  size: (path) => statSync(path).size,
};

/**
 * A TTY that is not CI. Both halves matter: `CI=1` on a developer's machine is
 * the documented way to force the non-interactive path.
 */
export function isInteractive(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !env.CI;
}

export function nodeBoundary(): Boundary {
  const interactive = isInteractive();
  return {
    exec: {
      async run(command, args, options = {}) {
        const result = await execa(command, args, {
          cwd: options.cwd,
          env: options.env,
          extendEnv: true,
          stdio: options.stdio === 'inherit' ? 'inherit' : 'pipe',
          input: options.input,
          timeout: options.timeoutMs,
          reject: false,
        });
        return asResult(result);
      },
      runSync(command, args, options = {}) {
        const result = execaSync(command, args, {
          cwd: options.cwd,
          env: options.env,
          extendEnv: true,
          stdio: options.stdio === 'inherit' ? 'inherit' : 'pipe',
          input: options.input,
          timeout: options.timeoutMs,
          reject: false,
        });
        return asResult(result);
      },
    },
    fs: nodeFileSystem,
    async http(request) {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return {
        status: response.status,
        ok: response.ok,
        headers,
        text: () => response.text(),
        json: <T>() => response.json() as Promise<T>,
      };
    },
    env: (name) => process.env[name],
    now: () => Math.floor(Date.now() / 1000),
    homedir: () => process.env.HOME ?? '',
    cwd: () => process.cwd(),
    log: {
      info: (m) => console.error(m),
      warn: (m) => console.error(m),
      error: (m) => console.error(m),
      step: (m) => {
        if (interactive) console.error(m);
      },
    },
    interactive,
  };
}
