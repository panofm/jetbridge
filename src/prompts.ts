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

export function clackPrompter(): Prompter {
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
