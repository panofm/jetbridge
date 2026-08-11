/**
 * The one place jetbridge talks to a person.
 *
 * `@clack/prompts` needs a terminal, so every question goes through this seam
 * instead: the wizard asks a `Prompter`, and a test hands it a script. Each
 * question carries a `name`, which is both the scripted answer's key and what
 * an unanswered prompt is reported as — a wizard that grew a question a test
 * never anticipated fails by name instead of hanging.
 */
import { confirm, isCancel, note, select, text } from '@clack/prompts';
import { isInteractive } from './boundary.js';
import { fail } from './project.js';

export interface Question {
  /** Stable key: the scripted answer's name, and what a missing answer reports. */
  name: string;
  message: string;
  /** Where a suggested value came from, shown next to the default. */
  hint?: string;
}

export interface TextQuestion extends Question {
  initial?: string;
  /** Returns a message when the answer is unusable, `undefined` when it is fine. */
  validate?: (value: string) => string | undefined;
}

export interface ConfirmQuestion extends Question {
  initial?: boolean;
}

export interface SelectQuestion<T extends string> extends Question {
  options: Array<{ value: T; label?: string; hint?: string }>;
  initial?: T;
}

export interface Prompter {
  text(question: TextQuestion): Promise<string>;
  confirm(question: ConfirmQuestion): Promise<boolean>;
  select<T extends string>(question: SelectQuestion<T>): Promise<T>;
  /** A block of text, not a question. */
  note(message: string, title?: string): void;
}

/** Ctrl-C is an answer too — the only correct response is to stop. */
const orCancel = <T>(value: T | symbol): T => {
  if (isCancel(value)) fail('cancelled — nothing was written');
  return value as T;
};

const withHint = (question: Question): string =>
  question.hint ? `${question.message} (${question.hint})` : question.message;

/**
 * The prompter for a run with nobody at the other end.
 *
 * Every question is a failure that names itself, because the alternatives are
 * both worse: prompting writes escape codes into a pipe and waits forever, and
 * silently defaulting answers a question nobody was asked on the operator's
 * behalf. A caller reaching this has a gap in its own flag handling — the
 * question's `name` is what says which one.
 *
 * `note` is not a question, so it still prints. Suppressing it would break the
 * `--yes` path, whose whole job is to show what it is about to write.
 */
export function nonInteractivePrompter(reason: string): Prompter {
  const refuse = (question: Question): never =>
    fail(
      `"${question.message}" needs an answer, and ${reason}.\n` +
        `  Pass the flag that supplies ${question.name}, or re-run on a terminal.`,
    );
  return {
    text: async (question) => refuse(question),
    confirm: async (question) => refuse(question),
    select: async (question) => refuse(question),
    note(message, title) {
      console.error(title ? `${title}\n${message}` : message);
    },
  };
}

/**
 * The terminal prompter — and the last line of defence for an unattended run.
 *
 * It reads the real streams rather than the boundary, because it IS the
 * terminal adapter: there is no seam left underneath it. When there is no
 * terminal it hands back the refusing prompter instead, so a code path that
 * forgets its own non-interactive check fails loudly rather than hanging. The
 * callers' checks are the contract; this is the guarantee.
 */
export function clackPrompter(): Prompter {
  if (!isInteractive()) {
    return nonInteractivePrompter('this run has no terminal to ask on');
  }
  return {
    async text(question) {
      const answer = orCancel(
        await text({
          message: withHint(question),
          initialValue: question.initial,
          validate: question.validate
            ? (value: string | undefined) => question.validate?.(value ?? '')
            : undefined,
        }),
      );
      return answer;
    },
    async confirm(question) {
      return orCancel(
        await confirm({ message: withHint(question), initialValue: question.initial ?? true }),
      );
    },
    async select(question) {
      // `select` is generic over a conditional option type, which does not
      // resolve for a caller's own type parameter — so it is called as the
      // string prompt it always is here, and the answer is narrowed back.
      const answer = orCancel(
        await select<string>({
          message: withHint(question),
          options: question.options.map((option) => ({
            value: option.value as string,
            label: option.label ?? option.value,
            ...(option.hint ? { hint: option.hint } : {}),
          })),
          initialValue: question.initial,
        }),
      );
      return answer as never;
    },
    note(message, title) {
      note(message, title);
    },
  };
}

export interface ScriptedPrompter extends Prompter {
  /** Question names, in the order they were asked. */
  asked: string[];
  notes: string[];
}

/**
 * The test counterpart. An answer the script does not carry is a failure, not a
 * default: a silently defaulted question is a wizard branch nobody verified.
 */
export function scriptedPrompter(answers: Record<string, string | boolean>): ScriptedPrompter {
  const asked: string[] = [];
  const notes: string[] = [];

  const answerFor = (question: Question): string | boolean => {
    asked.push(question.name);
    if (!(question.name in answers)) {
      throw new Error(
        `the wizard asked "${question.name}" (${question.message}) and the script has no answer`,
      );
    }
    return answers[question.name]!;
  };

  return {
    asked,
    notes,
    async text(question) {
      const answer = String(answerFor(question));
      const problem = question.validate?.(answer);
      if (problem) throw new Error(`scripted answer for "${question.name}" is invalid: ${problem}`);
      return answer;
    },
    async confirm(question) {
      return Boolean(answerFor(question));
    },
    async select(question) {
      const answer = String(answerFor(question));
      if (!question.options.some((option) => option.value === answer)) {
        throw new Error(
          `scripted answer "${answer}" is not one of the options for "${question.name}"`,
        );
      }
      return answer as never;
    },
    note(message, title) {
      notes.push(title ? `${title}: ${message}` : message);
    },
  };
}
