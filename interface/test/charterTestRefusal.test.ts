/**
 * A failed call as the test page shows it: the API's own status, code, sentence and details, with
 * nothing reworded, and anything that is not an answer of the API shown as such.
 */
import { describe, expect, test } from "vitest";
import { ApiError } from "@/lib/api/types";
import { apiKeys } from "@/lib/api/keys";
import { CHARTER_TEST_KEYS } from "@/lib/charterTest/hooks";
import { callLabel, fieldProblems, problemsAt, refusalView } from "@/lib/charterTest/refusal";

describe("a refusal, as served", () => {
  test("an answer of the API keeps its status, code, sentence and details", () => {
    const details = [{ field: "grant", problem: "must allow at least one act" }];
    const e = new ApiError(400, {
      code: "grant_not_valid",
      message: "The grant is not valid: each field named in the details breaks the rule given beside it, and no order was placed.",
      // The grant doors answer rows of `{ field, problem }`: read as served, whatever the type says.
      details: details as never,
    });
    expect(refusalView(e)).toEqual({
      api: true,
      status: 400,
      code: "grant_not_valid",
      message:
        "The grant is not valid: each field named in the details breaks the rule given beside it, and no order was placed.",
      details,
    });
  });

  test("an answer with no details says null", () => {
    const e = new ApiError(409, { code: "declaration_outdated", message: "Declared under another wording." });
    expect(refusalView(e)).toEqual({
      api: true,
      status: 409,
      code: "declaration_outdated",
      message: "Declared under another wording.",
      details: null,
    });
  });

  test("a failure that is not the API's has no status and no code", () => {
    expect(refusalView(new Error("User rejected the request."))).toEqual({
      api: false,
      status: null,
      code: null,
      message: "User rejected the request.",
      details: null,
    });
    expect(refusalView("plain text")).toMatchObject({ api: false, message: "plain text" });
  });

  test.each([[undefined], [null], [{}], [new Error("")], [""], [42]])(
    "a failure that says nothing (%j) still shows a line",
    (e) => {
      expect(refusalView(e)).toEqual({
        api: false,
        status: null,
        code: null,
        message: "No message.",
        details: null,
      });
    },
  );
});

describe("the rows of a refusal's details", () => {
  test("rows of field and problem, in their order", () => {
    const details = [
      { field: "acts.buy.per30Days", problem: "must be at least the amount per act" },
      { field: "endsOn", problem: "must be after today (UTC)" },
      { field: "acts.buy.per30Days", problem: "a second problem" },
    ];
    expect(fieldProblems(details)).toEqual(details);
    expect(problemsAt(fieldProblems(details), "acts.buy.per30Days")).toEqual([
      "must be at least the amount per act",
      "a second problem",
    ]);
    expect(problemsAt(fieldProblems(details), "acts.buy")).toEqual([]);
  });

  test("anything that is not such a row is left out, and nothing throws", () => {
    expect(fieldProblems(undefined)).toEqual([]);
    expect(fieldProblems(null)).toEqual([]);
    expect(fieldProblems({ reason: "x" })).toEqual([]);
    expect(fieldProblems("text")).toEqual([]);
    expect(
      fieldProblems([null, 3, "x", { field: 1, problem: "p" }, { path: "a", message: "b" }, { field: "f", problem: "p" }]),
    ).toEqual([{ field: "f", problem: "p" }]);
  });
});

describe("the name of the call a failure came from", () => {
  const TOKEN = "session-token-for-tests";

  test("the first two parts of the key, and never the token", () => {
    expect(callLabel(apiKeys.companies(TOKEN))).toBe("api.companies");
    expect(callLabel(apiKeys.legalBodyOrder(TOKEN, "lb_1"))).toBe("api.legalBodyOrder");
    expect(callLabel(apiKeys.worldIdMe(TOKEN))).toBe("api.worldIdMe");
    expect(callLabel(apiKeys.publicConfig())).toBe("api.publicConfig");
  });

  test("the test page's own keys name their door and hold the token third", () => {
    const keys = [
      CHARTER_TEST_KEYS.grantForm(TOKEN),
      CHARTER_TEST_KEYS.orderGrant(TOKEN, "lb_1"),
      CHARTER_TEST_KEYS.grantPreview(),
      CHARTER_TEST_KEYS.placeOrder(),
      CHARTER_TEST_KEYS.adoptionMessage(),
    ];
    expect(keys.map(callLabel)).toEqual([
      "api.charterTest:grantForm",
      "api.charterTest:orderGrant",
      "api.charterTest:grantPreview",
      "api.charterTest:placeOrder",
      "api.charterTest:adoptionMessage",
    ]);
    for (const key of keys) expect(callLabel(key)).not.toContain(TOKEN);
    expect(CHARTER_TEST_KEYS.grantForm(TOKEN)[2]).toBe(TOKEN);
  });

  test("no key of the site holds a token in its first two parts", () => {
    for (const [name, make] of Object.entries(apiKeys)) {
      if (typeof make !== "function") continue;
      const key = (make as (...args: string[]) => readonly unknown[])(TOKEN, TOKEN);
      expect(key.slice(0, 2), name).not.toContain(TOKEN);
      expect(callLabel(key), name).not.toContain(TOKEN);
    }
  });

  test("a key that is not text, or no key at all", () => {
    expect(callLabel(["signTypedData"])).toBe("signTypedData");
    expect(callLabel(["readContract", { address: "0x00" }])).toBe("readContract");
    expect(callLabel(undefined)).toBe("call");
    expect(callLabel([])).toBe("call");
    expect(callLabel("api")).toBe("call");
  });

  test("a long text in the first two parts is never shown", () => {
    const long = "t".repeat(49);
    expect(callLabel([long, "companies"])).toBe("companies");
    expect(callLabel(["api", long])).toBe("api");
    expect(callLabel([long, long, "third"])).toBe("call");
    expect(callLabel(["api", "x".repeat(48)])).toBe(`api.${"x".repeat(48)}`);
  });
});
