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
import { fail } from './errors.js';
import { createReporter, type Reporter } from './reporter.js';

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
  /** Overrides the default. A request that never answers is a hang, so there is always one. */
  timeoutMs?: number;
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

/**
 * Plain messages from deep inside a step — one line per profile provisioned,
 * per file patched. Every one of them goes through the reporter, which indents
 * them under the step that produced them; written straight to stderr they would
 * land ON the step's own half-drawn line.
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
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
  /**
   * Monotonic milliseconds since this process started — every duration the tool
   * reports is a difference of two readings. Separate from `now` on purpose: a
   * wall clock is what an NTP correction moves, and a build that appears to take
   * minus four seconds is worse than no timing at all.
   */
  elapsedMs(): number;
  homedir(): string;
  cwd(): string;
  log: Logger;
  /** Progress, timing and machine events. See `reporter.ts` for the two channels. */
  report: Reporter;
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
 * Is there a person to ask?
 *
 * A TTY that is not CI, and that nobody has explicitly opted out of. All three
 * halves matter: `CI=1` on a developer's machine is the documented way to force
 * the non-interactive path, and `JETBRIDGE_NON_INTERACTIVE` is the same lever
 * for someone who is not in CI and does not want to be prompted.
 *
 * Nothing REQUIRES any of them. No terminal is sufficient on its own — an agent
 * behind a pipe gets the unattended behaviour without setting a variable, which
 * is the whole point.
 */
export function isInteractive(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CI || env.JETBRIDGE_NON_INTERACTIVE) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** A request that never answers would hang forever, so one minute is the ceiling. */
const HTTP_TIMEOUT_MS = 60_000;

/**
 * How a child process gets its three streams.
 *
 * stdin is the one that hangs, and `stdio: 'pipe'` does NOT protect you: execa
 * leaves the pipe open when there is nothing to write to it, so a child that
 * reads stdin waits for input that never comes and the whole command stalls
 * with no output at all. That is the worst outcome for an unattended run — an
 * agent waits forever and the session dies having printed nothing.
 *
 * So stdin is attached only when there is genuinely something to answer with:
 * the caller's own `input`, or a real terminal with a person at it. Otherwise
 * it is closed, and a tool that decides to ask a question reads EOF and gives
 * up — which surfaces as an error, which is always better than a wait.
 */
function childStreams(
  options: RunOptions,
  interactive: boolean,
): { stdout: 'pipe' | 'inherit'; stderr: 'pipe' | 'inherit'; stdin?: 'inherit' | 'ignore' } {
  // Output still streams to the terminal when asked; only stdin is withheld.
  const output = options.stdio === 'inherit' ? ('inherit' as const) : ('pipe' as const);
  if (options.input !== undefined) return { stdout: output, stderr: output };
  return {
    stdout: output,
    stderr: output,
    stdin: options.stdio === 'inherit' && interactive ? 'inherit' : 'ignore',
  };
}

/**
 * The real reporter: human lines on stderr, machine events on stdout, and line
 * rewriting only where stderr is a terminal that can redraw them.
 */
export function nodeReporter(options: { json?: boolean } = {}): Reporter {
  return createReporter({
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    elapsedMs: () => performance.now(),
    tty: Boolean(process.stderr.isTTY),
    json: Boolean(options.json),
  });
}

export interface NodeBoundaryOptions {
  /**
   * Force the unattended path even on a terminal — what `--non-interactive`
   * hands down. Never needed behind a pipe, which is already unattended.
   */
  nonInteractive?: boolean;
  /** The CLI builds one before parsing, so a failure has somewhere to go. */
  reporter?: Reporter;
}

export function nodeBoundary(options: NodeBoundaryOptions = {}): Boundary {
  const report = options.reporter ?? nodeReporter();
  // `--json` is unattended by definition: a caller asking for machine output is
  // a machine. Without this a prompt would draw its frames on stdout, which is
  // the one stream that has to stay parseable.
  const interactive = isInteractive() && options.nonInteractive !== true && !report.json;
  return {
    exec: {
      async run(command, args, runOptions = {}) {
        const result = await execa(command, args, {
          cwd: runOptions.cwd,
          env: runOptions.env,
          extendEnv: true,
          ...childStreams(runOptions, interactive),
          ...(runOptions.input === undefined ? {} : { input: runOptions.input }),
          timeout: runOptions.timeoutMs,
          reject: false,
        });
        return asResult(result);
      },
      runSync(command, args, runOptions = {}) {
        const result = execaSync(command, args, {
          cwd: runOptions.cwd,
          env: runOptions.env,
          extendEnv: true,
          ...childStreams(runOptions, interactive),
          ...(runOptions.input === undefined ? {} : { input: runOptions.input }),
          timeout: runOptions.timeoutMs,
          reject: false,
        });
        return asResult(result);
      },
    },
    fs: nodeFileSystem,
    async http(request) {
      const timeoutMs = request.timeoutMs ?? HTTP_TIMEOUT_MS;
      let response: Response;
      try {
        response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // A blackholed host never answers and fetch never settles without this.
        // Reported as an ordinary failure, because a stalled command is worse.
        const reason =
          (error as Error)?.name === 'TimeoutError'
            ? `timed out after ${timeoutMs}ms`
            : String((error as Error)?.message ?? error);
        return fail(`${request.method} ${request.url} failed — ${reason}`);
      }
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
    elapsedMs: () => performance.now(),
    homedir: () => process.env.HOME ?? '',
    cwd: () => process.cwd(),
    report,
    log: {
      info: (m) => report.note(m),
      warn: (m) => report.warn(m),
      error: (m) => report.warn(m),
      step: (m) => report.note(m),
    },
    interactive,
  };
}
