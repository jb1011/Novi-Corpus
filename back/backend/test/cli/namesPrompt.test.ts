/**
 * `--names-prompt`'s reader, through the path a pipe takes (standard input that is not a
 * terminal): up to three lines, first name, last name, optional full name. Every name here is a
 * made-up fixture.
 */
import { PassThrough, Readable } from "node:stream";
import { expect, test } from "vitest";
import { readNames } from "../../src/cli/namesPrompt";

const piped = (text: string) => Readable.from([text]);

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
