import { describe, expect, test } from "vitest";
import { entranceMemory, entranceOffer } from "@/lib/legalBody/entrance";

describe("the entrance", () => {
  test("a hidden door, and a backend that does not say, skip it", () => {
    expect(entranceOffer("hidden")).toEqual({ kind: "skip" });
    expect(entranceOffer(undefined)).toEqual({ kind: "skip" });
  });

  test("an offered door asks, and can form", () => {
    expect(entranceOffer("offered")).toEqual({ kind: "ask", canForm: true, capReached: false });
  });

  test("a door at the cap asks, and cannot form", () => {
    const offer = entranceOffer("cap_reached");
    expect(offer).toEqual({ kind: "ask", canForm: false, capReached: true });
    expect(
      entranceMemory(
        { door: "form", identityChoice: "not-yet", signer: "this-wallet", agentId: "" },
        offer,
      ).door,
    ).toBe("declare");
  });

  test("the answers are the memory, and a typed name is not an identity number", () => {
    const offer = entranceOffer("offered");
    expect(
      entranceMemory(
        { door: "form", identityChoice: "has-one", signer: "elsewhere", agentId: "42" },
        offer,
      ),
    ).toEqual({
      door: "form",
      identityChoice: "has-one",
      signer: "elsewhere",
      suggestedAgentId: "42",
    });
    expect(
      entranceMemory(
        { door: "declare", identityChoice: "has-one", signer: "this-wallet", agentId: "Avery" },
        offer,
      ).suggestedAgentId,
    ).toBeNull();
  });
});