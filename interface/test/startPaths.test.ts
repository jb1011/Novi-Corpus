import { describe, expect, test } from "vitest";
import { fullProductGate } from "@/lib/start/paths";

describe("whether the full product is offered", () => {
  test("only an explicit answer decides", () => {
    expect(fullProductGate({ fullProductAvailable: true })).toBe("offered");
    expect(fullProductGate({ fullProductAvailable: false })).toBe("not_offered");
    expect(fullProductGate({})).toBe("unknown");
    expect(fullProductGate(undefined)).toBe("unknown");
  });
});
