import { expect, test } from "vitest";
import {
  normalizeHandle,
  shareOnX,
  utmFromSearch,
  validateApplication,
  type ApplyFields,
} from "@/lib/founding/apply";

const VALID: ApplyFields = {
  email: "Ada@Example.com",
  xHandle: "@Ada",
  agentName: "Invoice",
  description:
    "Pays approved invoices for a small team, and it already moves USDC when a human says yes.",
};

test("a valid application is normalized", () => {
  const result = validateApplication(VALID);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.email).toBe("ada@example.com");
  expect(result.value.xHandle).toBe("ada");
});

test("a blank X handle is allowed", () => {
  const result = validateApplication({ ...VALID, xHandle: "  " });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.xHandle).toBeNull();
});

test("a short description and a bad handle are refused", () => {
  const result = validateApplication({
    ...VALID,
    description: "too short",
    xHandle: "has a space",
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors.description).toBeTruthy();
  expect(result.errors.xHandle).toBeTruthy();
});

test("utm keeps campaign keys only", () => {
  expect(utmFromSearch("?utm_source=launch&email=ada@example.com")).toEqual({
    utm_source: "launch",
  });
  expect(normalizeHandle("  @Ada ")).toBe("ada");
});

test("the share link carries the page and the campaign", () => {
  const href = shareOnX("https://novicorpus.xyz/founding-5?utm_source=x&utm_medium=share");
  expect(href.startsWith("https://x.com/intent/post?")).toBe(true);
  expect(href).toContain("utm_source%3Dx");
});
