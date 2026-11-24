/**
 * Type-level checks, run by `tsc --noEmit`: what wagmi's `writeContractAsync` and
 * `signTypedDataAsync` accept, with their generics inferred from the argument as a screen would
 * call them. Nothing here runs: `typeLevel` is never called, and the one runtime test below only
 * lets vitest accept the file.
 *
 * Each `@ts-expect-error` is a shape wagmi must refuse. If one of them stops being an error, `tsc`
 * fails on the unused directive, and the shape has to be looked at again.
 */
import { expect, test } from "vitest";
import type { UseSignTypedDataReturnType, UseWriteContractReturnType } from "wagmi";
import {
  encodePointer,
  identityRegistryAbi,
  pointerCall,
  POINTER_KEY,
  potExecCall,
  potSetupCall,
  registerCall,
  type CallContext,
  type WriteRequest,
} from "@/lib/legalBody/chain";
import {
  multicall3Abi,
  POT_PERIOD_MINUTES,
  potAddresses,
  potChangeArgs,
  potSetupCalls,
  safeAbi,
  type PotAddresses,
} from "@/lib/legalBody/safePot";
import {
  LINK_FIELDS,
  type LegalBodyOrderView,
  type LinkTypedDataWire,
  type StatementTypedDataWire,
} from "@/lib/api/types";

declare const sign: UseSignTypedDataReturnType["signTypedDataAsync"];
declare const write: UseWriteContractReturnType["writeContractAsync"];
declare const link: LinkTypedDataWire;
declare const statement: StatementTypedDataWire;
declare const order: LegalBodyOrderView;

/** The public testnet identity registry and factory, and the live test body. */
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
const BODY = "0x5969B48ff7A3a4c6689366a9a6D7AA24b0C4b5EE" as const;
const CHAIN = 5042002;
const config: CallContext["config"] = { chainId: CHAIN, identityRegistry: REGISTRY, factory: FACTORY };
/** The real run's guardian, agent's key and Safe, and the pot's contracts on Arc testnet. */
const G = "0x15D4EE6F84b6bf8ceE5A24cCb19FDF8257c22b0A" as const;
const A = "0x2dDcf8da463526614b9FA5E87Db259a3Bf06667C" as const;
const POT = "0x0bbBa174c1D6b6Edd2F1A86ff5af435B645b77EF" as const;
const T = potAddresses(CHAIN) as PotAddresses;

export async function typeLevel() {
  // The two register overloads and the pointer, their arguments written out as literal tuples.
  await write({ abi: identityRegistryAbi, address: REGISTRY, functionName: "register", args: [] });
  await write({
    abi: identityRegistryAbi,
    address: REGISTRY,
    functionName: "register",
    args: ["https://example.com/agent.json"],
  });
  await write({
    abi: identityRegistryAbi,
    address: REGISTRY,
    functionName: "setMetadata",
    args: [BigInt(1), POINTER_KEY, encodePointer(CHAIN, BODY)],
    chainId: CHAIN,
    gas: BigInt(100_000),
  });

  // The flow's own request, handed over as built: its `args` is wide, so wagmi cannot pick an
  // overload from it. It reaches the wallet through one adapter, never directly.
  const r: WriteRequest = registerCall(config, null);
  // @ts-expect-error the wide `args: readonly unknown[]` satisfies no `register` overload
  await write(r);
  const p = pointerCall(config, order);
  if ("ok" in p) return;
  // @ts-expect-error the wide `args` does not satisfy `setMetadata`'s tuple either
  await write(p);

  // The pot's setup and an action of the guardian's, as wagmi takes them: both functions are
  // payable, the setup's value is the sum of its inner amounts, and the ten arguments of
  // `execTransaction` are the builders' own tuple.
  const pot = {
    guardian: G,
    agentWallet: A,
    token: T.usdc,
    ceilingUnits: BigInt(50_000_000),
    periodMinutes: POT_PERIOD_MINUTES,
  };
  const s = potSetupCalls(T, { ...pot, saltNonce: BigInt(1), fundWei: BigInt(0), agentGasWei: BigInt(0) });
  await write({
    abi: multicall3Abi,
    address: T.multicall3,
    functionName: "aggregate3Value",
    args: [s.calls],
    value: s.value,
    chainId: CHAIN,
    gas: BigInt(650_000),
  });
  await write({
    abi: safeAbi,
    address: POT,
    functionName: "execTransaction",
    args: potChangeArgs(T, pot),
    chainId: CHAIN,
    gas: BigInt(200_000),
  });
  // The flow's own pot requests carry the wide `args` too: through the one adapter only.
  const setup = potSetupCall(
    config,
    { kind: "setup", guardian: G, agentWallet: A, ceilingUnits: BigInt(50_000_000), saltNonce: BigInt(1), fundWei: BigInt(0), agentGasWei: BigInt(0) },
    BigInt(650_000),
  );
  if ("ok" in setup) return;
  // @ts-expect-error the wide `args` satisfies no `aggregate3Value` tuple
  await write(setup);
  const change = potExecCall(
    config,
    { kind: "change", pot: POT, guardian: G, agentWallet: A, ceilingUnits: BigInt(20_000_000) },
    BigInt(200_000),
  );
  if ("ok" in change) return;
  // @ts-expect-error nor the ten values of `execTransaction`
  await write(change);

  // Typed data in viem's own form: every uint256 a bigint, `EIP712Domain` left to viem.
  await sign({
    domain: link.domain,
    types: { LegalBodyLink: LINK_FIELDS },
    primaryType: "LegalBodyLink",
    message: {
      agentId: BigInt(link.message.agentId),
      guardian: link.message.guardian,
      amendmentDelay: BigInt(link.message.amendmentDelay),
      operatingAgreementHash: link.message.operatingAgreementHash,
      deadline: BigInt(link.message.deadline),
    },
  });
  // The served forms, as served.
  // @ts-expect-error the link's pinned field types make each uint256 a bigint; the wire has strings
  await sign(link);
  // @ts-expect-error the statement's declared, wide EIP712Domain types its domain as unknowns
  await sign(statement);
}

test("type-level only: the checks above are run by tsc", () => {
  expect(typeof typeLevel).toBe("function");
});
