/**
 * What a run looks like while it is happening, on two channels at once.
 *
 * A build is minutes long, so the facts you would abort on — which app, which
 * bundle id, which configuration, which devices, which profiles — are printed
 * BEFORE anything slow starts, and every slow thing is a step that announces
 * itself and then rewrites its own line with a duration. Nothing is silent for
 * minutes, and a wrong `--suffix` costs a second rather than a whole build.
 *
 * The two channels are the contract. Every human line goes to STDERR; `--json`
 * puts newline-delimited events on STDOUT and nothing else ever goes there. So
 * one caller pipes stdout to a parser while a person watches stderr.
 */
import chalk from 'chalk';

export type Fields = Record<string, unknown>;

/** A running step. Exactly one of `ok` / `fail` ends it. */
export interface Step {
  /** Trailing text on the finished line — `build 1786437647 (…)`. */
  detail(text: string): void;
  /** Fields for this step's machine event only. */
  data(fields: Fields): void;
  ok(): void;
  fail(): void;
}

/** One line of the header. `event` also emits it on the machine channel. */
export interface HeaderRow {
  label: string;
  text: string;
  event?: string;
  data?: Fields;
}

export interface RunStart {
  /** The machine name of the command: `install`, `link`, `bundles rm`. */
  command: string;
  /** Segments of the identity line — `Acme Wave · io.acme.app.dev.wave · Debug`. */
  title: string[];
  data?: Fields;
  rows?: HeaderRow[];
  /**
   * Step labels this run will use, where they are known up front — device names,
   * mostly. The label column is sized to them once, so one long name cannot make
   * every other row's duration sit somewhere else.
   */
  labels?: string[];
}

export interface Reporter {
  /**
   * The header, and the clock the closing total is measured from. Called once,
   * before the first slow step.
   */
  start(run: RunStart): void;
  /** A human aside. Never reaches the machine channel. */
  note(text: string): void;
  warn(text: string): void;
  begin(step: string, label: string): Step;
  /** `begin`, run, end — for a step that either returns or throws. */
  run<T>(step: string, label: string, body: (handle: Step) => Promise<T>): Promise<T>;
  /** One machine event. A no-op without `--json`. */
  emit(event: string, data?: Fields): void;
  /**
   * A stdout payload with a shape of its own — the `bundles ls` table, and its
   * `--json` array. Not an event, and never wrapped in one.
   */
  write(text: string): void;
  error(message: string): void;
  done(ok?: boolean, data?: Fields): void;
  readonly json: boolean;
}

export interface ReporterOptions {
  /** The machine channel. Written verbatim, newlines included. */
  out(text: string): void;
  /** The human channel. Written raw, so the reporter owns every newline. */
  err(text: string): void;
  /**
   * Monotonic milliseconds. Injected rather than read from `Date.now`, which
   * both jumps under NTP and cannot be controlled by a test.
   */
  elapsedMs(): number;
  /**
   * Whether a line can be rewritten in place. This is stderr's TTY-ness, not
   * stdout's: the escapes land on stderr, so `jetbridge install 2> build.log`
   * is exactly the case that must degrade to one plain line per step.
   */
  tty: boolean;
  json: boolean;
}

/** `0.3s` · `18s` · `1m 12s` · `2m`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  // Rounded once, then split — rounding after the split prints "60s".
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/**
 * The label column. `start` widens it to fit the labels a run declares — a
 * device is named by its owner and "Dev's development iPhone 17 Pro" is a real
 * name — and anything past the ceiling is truncated rather than allowed to push
 * one row's duration out of line with every other row's.
 */
const LABEL_WIDTH = 20;
const MAX_LABEL_WIDTH = 30;
const DURATION_WIDTH = 8;
const HEADER_LABEL_WIDTH = 9;
const TITLE_SEPARATOR = '  ·  ';
/** Sub-lines sit under the ✓ column, so it is obvious which step wrote them. */
const SUB_INDENT = '    ';

export function createReporter(options: ReporterOptions): Reporter {
  const { out, err, elapsedMs, tty, json } = options;
  let startedAt = elapsedMs();
  /** The un-terminated line currently on screen. Only ever set on a TTY. */
  let pending: string | null = null;
  /** Steps in flight — anything written now is theirs, and is indented under them. */
  let active = 0;
  let labelWidth = LABEL_WIDTH;

  const emit = (event: string, data: Fields = {}): void => {
    if (json) out(`${JSON.stringify({ event, ...data })}\n`);
  };

  const draw = (line: string): void => {
    pending = line;
    err(line);
  };

  const clear = (): void => {
    if (pending === null) return;
    err('\r\u001b[2K');
    pending = null;
  };

  /** A finished line, with whatever is mid-flight redrawn under it. */
  const line = (text: string): void => {
    const held = pending;
    clear();
    err(`${text}\n`);
    if (held !== null) draw(held);
  };

  /** Anything written while a step runs, indented under it rather than into it. */
  const message = (text: string, tint: (value: string) => string): void => {
    if (active === 0) {
      line(tint(text));
      return;
    }
    line(
      text
        .split('\n')
        .map((row) => `${SUB_INDENT}${tint(row)}`)
        .join('\n'),
    );
  };

  const fit = (label: string): string =>
    label.length > labelWidth ? `${label.slice(0, labelWidth - 1)}…` : label.padEnd(labelWidth);

  const finished = (ok: boolean, label: string, ms: number, detail: string): string => {
    const mark = ok ? chalk.green('✓') : chalk.red('✗');
    const duration = detail
      ? formatDuration(ms).padEnd(DURATION_WIDTH)
      : formatDuration(ms).trimEnd();
    return (
      `  ${mark} ${fit(label)} ${chalk.dim(duration)}` + (detail ? ` ${chalk.dim(detail)}` : '')
    );
  };

  const begin = (step: string, label: string): Step => {
    const began = elapsedMs();
    let detail = '';
    let fields: Fields = {};
    let ended = false;
    active += 1;
    emit('step', { step, phase: 'start' });
    if (tty) draw(`  ${chalk.dim('·')} ${label}`);

    const end = (ok: boolean): void => {
      if (ended) return;
      ended = true;
      active -= 1;
      const durationMs = elapsedMs() - began;
      clear();
      err(`${finished(ok, label, durationMs, detail)}\n`);
      emit('step', { step, phase: 'end', ok, durationMs, ...fields });
    };

    return {
      detail: (text) => {
        detail = text;
      },
      data: (extra) => {
        fields = { ...fields, ...extra };
      },
      ok: () => end(true),
      fail: () => end(false),
    };
  };

  return {
    json,
    start(run) {
      startedAt = elapsedMs();
      labelWidth = Math.min(
        MAX_LABEL_WIDTH,
        Math.max(LABEL_WIDTH, ...(run.labels ?? []).map((label) => label.length)),
      );
      emit('start', { command: run.command, ...run.data });
      line(chalk.bold(run.title.filter(Boolean).join(TITLE_SEPARATOR)));
      for (const row of run.rows ?? []) {
        line(`  ${chalk.dim(row.label.padEnd(HEADER_LABEL_WIDTH))} ${row.text}`);
        if (row.event) emit(row.event, row.data);
      }
      line('');
    },
    note: (text) => message(text, active > 0 ? chalk.dim : (value) => value),
    warn: (text) => message(text, chalk.yellow),
    begin,
    async run(step, label, body) {
      const handle = begin(step, label);
      try {
        const value = await body(handle);
        handle.ok();
        return value;
      } catch (error) {
        handle.fail();
        throw error;
      }
    },
    emit,
    write(text) {
      out(text.endsWith('\n') ? text : `${text}\n`);
    },
    error(message) {
      clear();
      err(`${chalk.red(`✗ ${message}`)}\n`);
      emit('error', { message });
    },
    done(ok = true, data = {}) {
      const durationMs = elapsedMs() - startedAt;
      // Nothing more to say after a ✗ — that line already ended the run.
      if (ok) {
        line('');
        line(chalk.dim(`done in ${formatDuration(durationMs)}`));
      }
      emit('done', { ok, durationMs, ...data });
    },
  };
}

/** The reporter a programmatic caller gets when it asks for nothing. */
export const silentReporter = (): Reporter =>
  createReporter({
    out: () => {},
    err: () => {},
    elapsedMs: () => 0,
    tty: false,
    json: false,
  });
