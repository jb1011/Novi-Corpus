import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { refuse } from "./operator";

/**
 * THE NAMES OF RECORD, TYPED AT A PROMPT (`--names-prompt` on `identity:record` and
 * `identity:correct-name`): read from the operator's terminal or from standard input, never from
 * the command line, so a name stays out of the shell history and the process list. What is read is
 * handed to the command and written into no ops line.
 */

/** The names as the operator typed them; the command applies `nameOfRecord` and the name rule. */
export interface PromptedNames {
  first: string;
  last: string;
  /** Absent when the operator skipped it (Enter at the prompt, or an empty or missing third line). */
  full?: string;
}

/** The options a command takes the names by: the three flags, or the prompt in their place. */
export interface NameFlagOptions {
  nameFirst?: string;
  nameLast?: string;
  nameFull?: string;
  namesPrompt?: boolean;
}

const NAME_FLAGS = [
  ["nameFirst", "--name-first"],
  ["nameLast", "--name-last"],
  ["nameFull", "--name-full"],
] as const;

/** At a terminal: three prompts on `output`, the full name optional. */
async function askAtTerminal(input: Readable, output: Writable): Promise<string[]> {
  const rl = createInterface({ input, output, terminal: true });
  const ask = (question: string) =>
    new Promise<string>((resolve) => rl.question(question, resolve));
  try {
    return [
      await ask("First name, as the guardian gave it and the document prints it: "),
      await ask("Last name, as the guardian gave it and the document prints it: "),
      await ask("Full name, optional (Enter to skip): "),
    ];
  } finally {
    rl.close();
  }
}

/** Not a terminal: up to `max` lines of `input`, in order. */
async function readLines(input: Readable, max: number): Promise<string[]> {
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY, terminal: false });
  const lines: string[] = [];
  try {
    for await (const line of rl) {
      lines.push(line);
      if (lines.length === max) break;
    }
  } finally {
    rl.close();
  }
  return lines;
}

/**
 * The first name, the last name and an optional full name: prompted for when `input` is a
 * terminal (the prompts on `output`, never on standard output, which carries the command's one
 * JSON object), else read as up to three lines in that order. Refused without a first and a last
 * line.
 */
export async function readNames(
  input: Readable & { isTTY?: boolean },
  output: Writable,
): Promise<PromptedNames> {
  const [first, last, full] =
    input.isTTY === true ? await askAtTerminal(input, output) : await readLines(input, 3);
  if (first === undefined || last === undefined)
    refuse("--names-prompt needs the first name and the last name, one per line");
  return full === undefined || full.trim() === "" ? { first, last } : { first, last, full };
}

/**
 * The options with `--names-prompt` resolved: the names read (`read`) in place of the three name
 * flags, which it is never combined with. Without the prompt, the options as they are.
 */
export async function withPromptedNames<T extends NameFlagOptions>(
  opts: T,
  read: () => Promise<PromptedNames>,
): Promise<Omit<T, "namesPrompt">> {
  const { namesPrompt, ...rest } = opts;
  if (namesPrompt !== true) return rest;
  for (const [key, flag] of NAME_FLAGS)
    if (opts[key] !== undefined)
      refuse(`--names-prompt cannot be combined with ${flag}: the names are read at the prompt`);
  const names = await read();
  return {
    ...rest,
    nameFirst: names.first,
    nameLast: names.last,
    ...(names.full === undefined ? {} : { nameFull: names.full }),
  };
}
