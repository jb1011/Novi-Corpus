/**
 * The intake's limits against the WIRE's (doola's published OpenAPI document, re-read 2026-11-11).
 *
 * Both values below are filed as doola's `description`, whose documented maximum is 50
 * characters. A value over it is not refused by us and accepted by doola: it is accepted by us
 * and refused by doola, after the customer was created, which parks the filing for a human. So
 * the two bounds are pinned to doola's constant here, and a change to either that crosses it
 * fails in this file rather than against the sandbox.
 */
import { expect, test } from "vitest";
import { DOOLA_DESCRIPTION_MAX_LENGTH } from "../../src/adapters/doola/types";
import { DEFAULT_DESCRIPTION, PURPOSE_MAX_LENGTH } from "../../src/formation/intake";

test("doola's documented `description` limit is 50 characters", () => {
  expect(DOOLA_DESCRIPTION_MAX_LENGTH).toBe(50);
});

test("the purpose bound every door applies never exceeds what doola accepts", () => {
  expect(PURPOSE_MAX_LENGTH).toBeLessThanOrEqual(DOOLA_DESCRIPTION_MAX_LENGTH);
});

test("the fallback description fits doola's limit, and is not blank", () => {
  // doola's `minLength` is 1, so the fallback must say something as well as fit.
  expect(DEFAULT_DESCRIPTION.length).toBeLessThanOrEqual(DOOLA_DESCRIPTION_MAX_LENGTH);
  expect(DEFAULT_DESCRIPTION.trim().length).toBeGreaterThan(0);
  // …and it would pass our own door too, so a company that falls back to it files.
  expect(DEFAULT_DESCRIPTION.length).toBeLessThanOrEqual(PURPOSE_MAX_LENGTH);
});
