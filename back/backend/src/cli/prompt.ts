import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/**
 * WHAT AN OPERATOR TYPES AT A PROMPT, never on the command line, so it stays out of the shell
 * history and the process list: the names of record (`--names-prompt`, namesPrompt.ts) and the
 * address an email goes to (`--to-prompt`, email.ts).
 *
 * At a terminal, one prompt per answer on `output` (standard error: standard output carries the
 * command's one JSON object). Readline echoes what is typed into `output` only when that is a
 * terminal too: into a redirected standard error it would write the answers, so there the
 * terminal's own echo shows them instead. The input's end at a prompt (Ctrl-D) is refused, never
 * left pending. Not at a terminal (a pipe), the answers are the input's first lines, in order.
 */

async function askAtTerminal(
  input: Readable,
  output: Writable & { isTTY?: boolean },
  questions: readonly string[],
  notEntered: string,
): Promise<string[]> {
  const rl = createInterface({ input, output, terminal: output.isTTY === true });
  let closed = false;
  rl.once("close", () => {
    closed = true;
  });
  const ask = (question: string) =>
    new Promise<string>((resolve, reject) => {
      const unanswered = () => reject(new Error(`refusing: ${notEntered}`));
      // The input may have ended with the previous answer, before this prompt.
      if (closed) return unanswered();
      rl.once("close", unanswered);
      rl.question(question, (answer) => {
        rl.off("close", unanswered);
        resolve(answer);
      });
    });
  try {
    const answers: string[] = [];
    for (const question of questions) answers.push(await ask(question));
    return answers;
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
 * One answer per question: prompted for when `input` is a terminal (refused with `notEntered`
 * when the input ends at a prompt), else read as up to that many lines, so fewer may come back
 * from a pipe. The caller decides what a missing answer means.
 */
export async function readAnswers(
  input: Readable & { isTTY?: boolean },
  output: Writable & { isTTY?: boolean },
  questions: readonly string[],
  notEntered: string,
): Promise<string[]> {
  return input.isTTY === true
    ? askAtTerminal(input, output, questions, notEntered)
    : readLines(input, questions.length);
}
