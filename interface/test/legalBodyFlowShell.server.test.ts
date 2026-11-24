/**
 * The flow's shell (`LegalBodyFlow.tsx`) and the agent's wallet, read from its source.
 *
 * The derivation decides the wallet phase from the registry's answer, and the step draws it; both
 * are tested on their own. What ties them is the shell: it reads `getAgentWallet` for a draft with
 * an identity, hands the answer to the derivation, renders the step on the wallet phase, and sends
 * a link door's "wallet" refusal back there with the registry read again. A regression in that
 * wiring (the read always null, its `enabled` flipped, the case dropped) would leave every other
 * test green while every draft sits on "checking" or skips to the link, so these guards pin it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const code = readFileSync(
  fileURLToPath(new URL("../src/components/legalBody/LegalBodyFlow.tsx", import.meta.url)),
  "utf8",
);

/** The source from the first `start` at or after `from` up to the first `end` after it. */
function between(start: string, end: string, from = 0): string {
  const at = code.indexOf(start, from);
  expect(at, start).toBeGreaterThan(-1);
  const to = code.indexOf(end, at + start.length);
  expect(to, end).toBeGreaterThan(at);
  return code.slice(at, to);
}

describe("the registry's answer for the draft's identity", () => {
  test("one read of getAgentWallet, on only for a draft with an identity, never retried by itself", () => {
    expect(code.match(/useReadContract\(/g)).toHaveLength(1);
    expect(code).toContain('const walletReadOn = order?.state === "draft" && choices.agentId !== null;');
    const read = between("useReadContract({", "});");
    expect(read).toContain("address: config.identityRegistry,");
    expect(read).toContain("abi: identityRegistryAbi,");
    expect(read).toContain('functionName: "getAgentWallet",');
    expect(read).toContain("args: [BigInt(choices.agentId ?? 0)],");
    expect(read).toContain("chainId: config.chainId,");
    expect(read).toContain("enabled: walletReadOn,");
    expect(read).toContain("retry: false,");
    // Never on focus or on reconnect: a failed read would pull a person off the link step.
    expect(read).toContain("refetchOnWindowFocus: false,");
    expect(read).toContain("refetchOnReconnect: false,");
  });

  test("its answer goes to the derivation and to the steps", () => {
    expect(code).toContain(
      "const agentWallet = choices.agentId === null ? null : agentWalletReadOf(agentWalletQuery);",
    );
    // The derivation's input names it (shorthand for `agentWallet: agentWalletReadOf(...)`).
    expect(between("deriveLegalBodyPhase({", "}),")).toMatch(/\n\s*agentWallet,\n/);
    const kit = between("const kit: LegalBodyStepKit = {", "};");
    expect(kit).toMatch(/\n\s*agentWallet,\n/);
    expect(kit).toMatch(/\n\s*refreshAgentWallet,\n/);
  });

  test("read again only on a click, and only while the read is on", () => {
    const refresh = between("async function refreshAgentWallet()", "\n  }\n");
    expect(refresh).toContain("if (!walletReadOn) return;");
    expect(refresh).toContain("await agentWalletQuery.refetch();");
  });
});

describe("the wallet phase", () => {
  test('case "wallet" renders the agent\'s wallet step, in its draft mode, one per order', () => {
    const wallet = between('case "wallet":', 'case "link":', code.indexOf("function body()"));
    expect(wallet).toContain(
      '<AgentWalletStep key={kit.orderId ?? "none"} kit={kit} agentId={choices.agentId} />',
    );
    // The draft is the step's default mode: the shell's read and the derivation drive it.
    expect(wallet).not.toContain("mode=");
  });

  test("a link door's wallet refusal reads the registry again and carries its sentence there", () => {
    const sendBack = code.indexOf("async function sendBack(");
    expect(sendBack).toBeGreaterThan(-1);
    const wallet = between('case "wallet":', "return;", sendBack);
    expect(wallet).toContain('setCarried({ to: "wallet", sentence });');
    expect(wallet).toContain("await refreshAgentWallet();");
  });
});
