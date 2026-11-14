import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeFailure, requireExistingDatabase } from "../../src/cli/ledgerPrefill";

describe("ledger:prefill database check", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("refuses a database file that does not exist and names the absolute path", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-prefill-"));
    dirs.push(dir);
    const missing = join(dir, "legalbody.db");
    expect(() => requireExistingDatabase(missing)).toThrow(`No database at ${missing}`);
  });

  it("resolves a relative path before refusing, so the message says where it looked", () => {
    expect(() => requireExistingDatabase("./no-such-data/legalbody.db")).toThrow(
      join(process.cwd(), "no-such-data", "legalbody.db"),
    );
  });

  it("returns the absolute path of a database that exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-prefill-"));
    dirs.push(dir);
    const file = join(dir, "legalbody.db");
    writeFileSync(file, "");
    const resolved = requireExistingDatabase(file);
    expect(isAbsolute(resolved)).toBe(true);
    expect(resolved).toBe(file);
  });
});

describe("ledger:prefill failure output", () => {
  it("prints the message alone when there is no cause", () => {
    expect(describeFailure(new Error("rpc refused"))).toBe("rpc refused");
  });

  it("prints each cause on its own line, innermost last", () => {
    const inner = new Error("ECONNRESET");
    const middle = new Error("fetch failed", { cause: inner });
    const outer = new Error("WILDCARD_ROLE ledger replay failed", { cause: middle });
    expect(describeFailure(outer)).toBe(
      "WILDCARD_ROLE ledger replay failed\ncause: fetch failed\ncause: ECONNRESET",
    );
  });

  it("stringifies a non-Error throw and a non-Error cause", () => {
    expect(describeFailure("plain string")).toBe("plain string");
    expect(describeFailure(new Error("outer", { cause: 42 }))).toBe("outer\ncause: 42");
  });
});
