/**
 * Where the retention sweep lives: under `identity/`, so the API process, whose scheduler runs it
 * daily, loads no module of the operator's command line. Its behaviour is held by the
 * `identity:sweep` tests in test/cli/identityCommands.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const source = (...path: string[]): string =>
  readFileSync(join(import.meta.dirname, "..", "..", "src", ...path), "utf8");
const IMPORTS_THE_CLI = /from "\.\.\/cli\//;

test("the sweep is in identity/sweep.ts: the scheduler's jobs and the identity:sweep command import it from there, and neither it nor the jobs import the CLI", () => {
  const sweep = source("identity", "sweep.ts");
  const jobs = source("scheduler", "jobs.ts");
  const cli = source("cli", "identity.ts");

  expect(sweep).toContain("export function sweepIdentityNames(");
  expect(sweep).not.toMatch(IMPORTS_THE_CLI);
  expect(jobs).toMatch(/import \{ sweepIdentityNames \} from "\.\.\/identity\/sweep";/);
  expect(jobs).not.toMatch(IMPORTS_THE_CLI);
  expect(cli).toMatch(/from "\.\.\/identity\/sweep";/);
  expect(cli).not.toContain("function sweepIdentityNames(");
});
