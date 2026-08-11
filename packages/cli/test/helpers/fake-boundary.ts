/**
 * The in-memory counterpart to `nodeBoundary`. Every command, request and file
 * write is recorded so a test can assert the exact argv array jetbridge would
 * have handed to `xcodebuild` — without an Xcode installation.
 */
import { dirname, resolve } from 'node:path';
import type {
  Boundary,
  CommandCall,
  CommandResult,
  FileSystem,
  HttpRequest,
  HttpResponse,
  RunOptions,
} from '../../src/boundary.js';

export interface StubbedCommand {
  /** Matches when every token appears in `[command, ...args]`, in order. */
  match: string[];
  stdout?: string;
  stderr?: string;
  code?: number;
}

export interface StubbedRequest {
  method?: string;
  /** Substring match on the URL. */
  url: string;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface FakeBoundaryOptions {
  files?: Record<string, string>;
  commands?: StubbedCommand[];
  requests?: StubbedRequest[];
  env?: Record<string, string>;
  now?: number;
  homedir?: string;
  cwd?: string;
  interactive?: boolean;
  /** Unmatched commands fail loudly by default; some tests want a quiet zero. */
  defaultCommandResult?: Partial<CommandResult>;
}

export interface FakeBoundary extends Boundary {
  calls: CommandCall[];
  requests: HttpRequest[];
  writes: string[];
  files: Map<string, string | Uint8Array>;
  /** Every argv the fake saw, joined — handy for a quick `toContain`. */
  commandLines(): string[];
  findCall(...tokens: string[]): CommandCall | undefined;
}

const matches = (argv: string[], tokens: string[]): boolean => {
  let at = 0;
  for (const token of tokens) {
    const found = argv.indexOf(token, at);
    if (found === -1) return false;
    at = found + 1;
  }
  return true;
};

export function fakeBoundary(options: FakeBoundaryOptions = {}): FakeBoundary {
  const cwd = options.cwd ?? '/project';
  const files = new Map<string, string | Uint8Array>();
  for (const [path, contents] of Object.entries(options.files ?? {})) {
    files.set(resolve(cwd, path), contents);
  }

  const calls: CommandCall[] = [];
  const requests: HttpRequest[] = [];
  const writes: string[] = [];
  const directories = new Set<string>();
  for (const path of files.keys()) {
    for (let dir = dirname(path); dir !== '/' && dir !== '.'; dir = dirname(dir)) {
      directories.add(dir);
    }
  }

  const fs: FileSystem = {
    exists: (path) => files.has(resolve(cwd, path)) || directories.has(resolve(cwd, path)),
    read: (path) => {
      const value = files.get(resolve(cwd, path));
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return typeof value === 'string' ? value : new TextDecoder().decode(value);
    },
    readBytes: (path) => {
      const value = files.get(resolve(cwd, path));
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return typeof value === 'string' ? new TextEncoder().encode(value) : value;
    },
    write: (path, contents) => {
      const full = resolve(cwd, path);
      files.set(full, contents);
      writes.push(full);
      for (let dir = dirname(full); dir !== '/' && dir !== '.'; dir = dirname(dir)) {
        directories.add(dir);
      }
    },
    mkdirp: (path) => {
      for (let dir = resolve(cwd, path); dir !== '/' && dir !== '.'; dir = dirname(dir)) {
        directories.add(dir);
      }
    },
    readdir: (path) => {
      const prefix = resolve(cwd, path) + '/';
      const names = new Set<string>();
      for (const key of [...files.keys(), ...directories]) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest) names.add(rest.split('/')[0]!);
      }
      return [...names].sort();
    },
    rm: (path, opts) => {
      const full = resolve(cwd, path);
      files.delete(full);
      directories.delete(full);
      if (opts?.recursive) {
        const prefix = full + '/';
        for (const key of [...files.keys()]) if (key.startsWith(prefix)) files.delete(key);
        for (const key of [...directories]) if (key.startsWith(prefix)) directories.delete(key);
      }
    },
    isDirectory: (path) => directories.has(resolve(cwd, path)),
    size: (path) => {
      const value = files.get(resolve(cwd, path));
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return typeof value === 'string' ? new TextEncoder().encode(value).length : value.length;
    },
  };

  const runStub = (command: string, args: string[], opts: RunOptions): CommandResult => {
    calls.push({ command, args, options: opts });
    const argv = [command, ...args];
    const stub = options.commands?.find((c) => matches(argv, c.match));
    if (!stub) {
      const fallback = options.defaultCommandResult;
      if (fallback) {
        return {
          ok: (fallback.code ?? 0) === 0,
          code: fallback.code ?? 0,
          stdout: fallback.stdout ?? '',
          stderr: fallback.stderr ?? '',
        };
      }
      return { ok: false, code: 127, stdout: '', stderr: `no stub for: ${argv.join(' ')}` };
    }
    return {
      ok: (stub.code ?? 0) === 0,
      code: stub.code ?? 0,
      stdout: stub.stdout ?? '',
      stderr: stub.stderr ?? '',
    };
  };

  const logs: string[] = [];

  return {
    calls,
    requests,
    writes,
    files,
    commandLines: () => calls.map((c) => [c.command, ...c.args].join(' ')),
    findCall: (...tokens: string[]) => calls.find((c) => matches([c.command, ...c.args], tokens)),
    exec: {
      run: async (command, args, opts = {}) => runStub(command, args, opts),
      runSync: (command, args, opts = {}) => runStub(command, args, opts),
    },
    fs,
    http: async (request: HttpRequest): Promise<HttpResponse> => {
      requests.push(request);
      const stub = options.requests?.find(
        (r) =>
          request.url.includes(r.url) &&
          (!r.method || r.method.toUpperCase() === request.method.toUpperCase()),
      );
      const status = stub?.status ?? (stub ? 200 : 404);
      const body = stub?.body ?? {};
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      return {
        status,
        ok: status >= 200 && status < 300,
        headers: stub?.headers ?? {},
        text: async () => text,
        json: async <T>() => (typeof body === 'string' ? JSON.parse(body) : body) as T,
      };
    },
    env: (name) => options.env?.[name],
    now: () => options.now ?? 1_700_000_000,
    homedir: () => options.homedir ?? '/home/dev',
    cwd: () => cwd,
    log: {
      info: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m),
      step: (m) => logs.push(m),
    },
    interactive: options.interactive ?? false,
  };
}
