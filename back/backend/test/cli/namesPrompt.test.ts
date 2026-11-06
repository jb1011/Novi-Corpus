/**
 * `--names-prompt`'s reader, through the path a pipe takes (standard input that is not a
 * terminal): up to three lines, first name, last name, optional full name; and through the
 * terminal's path, its streams stood in for by in-memory ones marked as terminals. Every name here
 * is a made-up fixture.
 */
import { PassThrough, Readable } from "node:stream";
import { expect, test, vi } from "vitest";
import { readNames } from "../../src/cli/namesPrompt";

const piped = (text: string) => Readable.from([text]);

const FIRST_PROMPT = "First name, as the guardian gave it and the document prints it: ";
const LAST_PROMPT = "Last name, as the guardian gave it and the document prints it: ";
const FULL_PROMPT = "Full name, optional (Enter to skip): ";

/** An in-memory stream marked as a terminal, as `process.stdin` reads at one. */
const keyboard = (): PassThrough & { isTTY: true } =>
  Object.assign(new PassThrough(), { isTTY: true as const });

/** Where the prompts go, as a terminal or as a redirected file; what is written is collected. */
function screen(isTTY: boolean): { stream: PassThrough; text: () => string } {
  const stream = isTTY ? Object.assign(new PassThrough(), { isTTY: true }) : new PassThrough();
  let text = "";
  stream.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  return { stream, text: () => text };
}

/** Types `typed` on `keys` once `prompt` is on the screen, as an operator answers each prompt. */
async function answer(
  on: ReturnType<typeof screen>,
  prompt: string,
  keys: PassThrough,
  typed: string,
): Promise<void> {
  await vi.waitFor(() => expect(on.text()).toContain(prompt));
  keys.write(typed);
}

test("three lines are the first, last and full names; Windows line ends read the same", async () => {
  const prompts = new PassThrough();
  expect(await readNames(piped("Jean\nDUPONT\nJean Pierre Dupont\n"), prompts)).toEqual({
    first: "Jean",
    last: "DUPONT",
    full: "Jean Pierre Dupont",
  });
  expect(await readNames(piped("Jean\r\nDUPONT\r\n"), prompts)).toEqual({
    first: "Jean",
    last: "DUPONT",
  });
  // Nothing is prompted for on a pipe.
  expect(prompts.read()).toBeNull();
});

test("only the first three lines are read", async () => {
  expect(await readNames(piped("Jean\nDupont\n\nsomething else\n"), new PassThrough())).toEqual({
    first: "Jean",
    last: "Dupont",
  });
});

test("fewer than two lines is refused", async () => {
  for (const text of ["", "Jean", "Jean\n"])
    await expect(readNames(piped(text), new PassThrough()), JSON.stringify(text)).rejects.toThrow(
      "refusing: --names-prompt needs the first name and the last name, one per line",
    );
});

test("at a terminal, typed names are read and, with standard error redirected, never echoed into it", async () => {
  const keys = keyboard();
  // Standard error redirected to a file: not a terminal.
  const file = screen(false);
  const names = readNames(keys, file.stream);
  await answer(file, FIRST_PROMPT, keys, "Jean\n");
  await answer(file, LAST_PROMPT, keys, "DUPONT\n");
  await answer(file, FULL_PROMPT, keys, "\n");

  expect(await names).toEqual({ first: "Jean", last: "DUPONT" });
  expect(file.text()).not.toMatch(/jean|dupont/i);
});

test("at a terminal, Ctrl-D at a prompt is refused, never left pending", async () => {
  const keys = keyboard();
  const tty = screen(true);
  const names = readNames(keys, tty.stream);
  await answer(tty, FIRST_PROMPT, keys, "Jean\r");
  await answer(tty, LAST_PROMPT, keys, "\x04");
  await expect(names).rejects.toThrow("refusing: the names were not entered");

  // Typed ahead in one burst: the input is closed before the next prompt is asked.
  const ahead = keyboard();
  const early = readNames(ahead, screen(true).stream);
  ahead.write("Jean\r\x04");
  await expect(early).rejects.toThrow("refusing: the names were not entered");
});

test("at a terminal with standard error redirected, the input's end at a prompt is refused", async () => {
  const prompts = [FIRST_PROMPT, LAST_PROMPT, FULL_PROMPT];
  for (const typed of [[], ["Jean\n"], ["Jean\n", "DUPONT\n"]]) {
    const keys = keyboard();
    const file = screen(false);
    const names = readNames(keys, file.stream);
    for (const [i, line] of typed.entries()) await answer(file, prompts[i] as string, keys, line);
    await vi.waitFor(() => expect(file.text()).toContain(prompts[typed.length] as string));
    keys.end();
    await expect(names, JSON.stringify(typed)).rejects.toThrow(
      "refusing: the names were not entered",
    );
  }
});
