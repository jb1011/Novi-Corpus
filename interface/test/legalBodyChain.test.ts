/**
 * The legal-body chain layer: the pointer against the value the live testnet body carries, the
 * selectors of the pinned fragments, one refusing case per rule of the allowlist (and its order),
 * the send door, and the mint parse. Every request a wallet could be handed goes through
 * `allowedCall`; these tables are what it refuses.
 */
import { describe, expect, test, vi } from "vitest";
import {
  decodeFunctionData,
  encodeFunctionData,
  keccak256,
  size,
  toBytes,
  toEventSelector,
  toFunctionSelector,
  type AbiFunction,
} from "viem";
import {
  agentIdFromMint,
  agentWalletCall,
  allowedCall,
  encodePointer,
  formatNative,
  identityRegistryAbi,
  legalBodyFactoryAbi,
  NATIVE_DECIMALS,
  pointerCall,
  pointerMatchesFactory,
  POINTER_KEY,
  POINTER_VERSION,
  potExecCall,
  potSetupCall,
  registerCall,
  sendAllowedCall,
  TRANSFER_TOPIC,
  walletKindOf,
  type CallContext,
  type PotCallContext,
  type WriteRequest,
} from "@/lib/legalBody/chain";
import {
  erc20Abi,
  multicall3Abi,
  ownerApprovalSignature,
  POT_CEILING_MAX_USDC,
  POT_FUND_MAX_UNITS,
  potAddresses,
  potSetupCalls,
  safeAbi,
  USDC_UNIT,
  WEI_PER_UNIT,
  type Call3Value,
  type PotAddresses,
} from "@/lib/legalBody/safePot";
import { arcTestnet } from "@/lib/chain";
import type { Address, Hex, LegalBodyOrderView } from "@/lib/api/types";

/** The public testnet identity registry and factory, and the live test body (agent 897126). */
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
const LIVE_BODY = "0x5969B48ff7A3a4c6689366a9a6D7AA24b0C4b5EE" as const;
const LIVE_AGENT = "897126";
/** Two of anvil's published test accounts, as served (checksummed). */
const GUARDIAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const OTHER_WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
/** Inventions. */
const ANOTHER_CONTRACT = "0x00000000000000000000000000000000000c0de1" as const;
const ANOTHER_FACTORY = "0x00000000000000000000000000000000000fac70" as const;
const ANOTHER_BODY = "0x00000000000000000000000000000000000b0d1e" as const;
const CHAIN = 5042002;
const OTHER_CHAIN = 5042;

/** The pointer for chain 5042002 (0x4cef52) and the live body, written out word by word:
 *  version 1, the chain id, the body address. */
const LIVE_POINTER = ("0x" +
  "0".repeat(63) +
  "1" +
  "0".repeat(58) +
  "4cef52" +
  "0".repeat(24) +
  "5969b48ff7a3a4c6689366a9a6d7aa24b0c4b5ee") as Hex;

const upper = (a: string) => `0x${a.slice(2).toUpperCase()}` as Address;
const lower = (a: string) => a.toLowerCase() as Address;

const config: CallContext["config"] = { chainId: CHAIN, identityRegistry: REGISTRY, factory: FACTORY };

/** A deployed body waiting for its pointer, on the configured deployment. */
const order = (over: Partial<LegalBodyOrderView> = {}): LegalBodyOrderView => ({
  id: "lb_a",
  publicId: "pub_a",
  companyId: "co_a",
  state: "deployed",
  chainId: CHAIN,
  factory: FACTORY,
  guardian: GUARDIAN,
  amendmentDelay: 172_800,
  agreement: { hash: `0x${"9c".repeat(32)}`, version: 1 },
  agentId: LIVE_AGENT,
  identityOwner: GUARDIAN,
  bodyAddress: LIVE_BODY,
  linkDeadline: 1_791_003_600,
  createTxHash: `0x${"ab".repeat(32)}`,
  deployedAt: 1_791_000_000,
  pointerSeenAt: null,
  createdAt: "2026-10-12T10:00:00Z",
  lapseReason: null,
  brokenReason: null,
  revoked: false,
  supersededBy: null,
  replacedBy: null,
  companyName: "Example Test Holdings LLC",
  ...over,
});

/** The pointer request for the default order, as the flow builds it. */
function goodPointer(): WriteRequest {
  const req = pointerCall(config, order());
  if ("ok" in req) throw new Error(`the pointer call was refused: ${req.problem}`);
  return req;
}

const ctx: CallContext = { config, order: order() };

/** The agent's wallet step: anvil's second account for the live identity, a deadline 270 seconds
 *  after the chain's time, and a 65-byte signature (an invention: the allowlist reads its shape,
 *  never whom it recovers to). */
const NOW = 1_791_000_000;
const DEADLINE = BigInt(NOW + 270);
const SIGNATURE = `0x${"5a".repeat(65)}` as Hex;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const WALLET: NonNullable<CallContext["wallet"]> = { agentId: LIVE_AGENT, guardian: GUARDIAN, nowSeconds: NOW };

/** A draft's context for the wallet step: no order, the identity and the chain's time. */
const walletCtx = (over: Partial<NonNullable<CallContext["wallet"]>> = {}): CallContext => ({
  config,
  order: null,
  wallet: { ...WALLET, ...over },
});

/** The agent's wallet request, written out as the registry takes it. */
const goodWallet = (): WriteRequest => ({
  chainId: CHAIN,
  address: REGISTRY,
  abi: identityRegistryAbi,
  functionName: "setAgentWallet",
  args: [BigInt(LIVE_AGENT), OTHER_WALLET, DEADLINE, SIGNATURE],
});

/** The same request with one of its four arguments changed. */
const walletWith = (i: number, value: unknown): WriteRequest => {
  const req = goodWallet();
  const args = [...req.args];
  args[i] = value;
  return { ...req, args };
};

/** What the registry gets for the default wallet request, over the pinned ABI. */
const walletData = () =>
  encodeFunctionData({
    abi: identityRegistryAbi,
    functionName: "setAgentWallet",
    args: [BigInt(LIVE_AGENT), OTHER_WALLET, DEADLINE, SIGNATURE],
  });

describe("the pinned values", () => {
  test("the pointer key, its version and Arc's native decimals", () => {
    expect(POINTER_KEY).toBe("legalBody");
    expect(POINTER_VERSION).toBe(1);
    expect(NATIVE_DECIMALS).toBe(18);
    expect(NATIVE_DECIMALS).toBe(arcTestnet.nativeCurrency.decimals);
  });

  test("the Transfer topic is the pinned event's selector", () => {
    expect(TRANSFER_TOPIC).toBe(
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    );
    expect(keccak256(toBytes("Transfer(address,address,uint256)"))).toBe(TRANSFER_TOPIC);
    const transfer = identityRegistryAbi.find((i) => i.type === "event" && i.name === "Transfer");
    if (!transfer || transfer.type !== "event") throw new Error("no Transfer event in the fragment");
    expect(toEventSelector(transfer)).toBe(TRANSFER_TOPIC);
  });

  const fn = (name: string, inputs: number): AbiFunction => {
    const item = identityRegistryAbi.find(
      (i) => i.type === "function" && i.name === name && i.inputs.length === inputs,
    );
    if (!item || item.type !== "function") throw new Error(`no ${name}/${inputs} in the fragment`);
    return item;
  };

  test("the four writes carry the registry's selectors", () => {
    // The first three are the ones the live run used.
    expect(toFunctionSelector(fn("register", 0))).toBe("0x1aa3a008");
    expect(toFunctionSelector(fn("register", 1))).toBe("0xf2c298be");
    expect(toFunctionSelector(fn("setMetadata", 3))).toBe("0x466648da");
    expect(toFunctionSelector(fn("setAgentWallet", 4))).toBe("0x2d1ef5ae");
    expect(keccak256(toBytes("setAgentWallet(uint256,address,uint256,bytes)")).slice(0, 10)).toBe(
      "0x2d1ef5ae",
    );
    expect(fn("setAgentWallet", 4).inputs.map((p) => p.name)).toEqual([
      "agentId",
      "newWallet",
      "deadline",
      "signature",
    ]);
    expect(fn("setAgentWallet", 4).outputs).toEqual([]);
  });

  test("eip712Domain is ERC-5267's view: no input, the seven values of the domain", () => {
    const domain = fn("eip712Domain", 0);
    expect(toFunctionSelector(domain)).toBe("0x84b0196e");
    expect(domain.stateMutability).toBe("view");
    expect(domain.outputs.map((p) => `${p.type} ${p.name}`)).toEqual([
      "bytes1 fields",
      "string name",
      "string version",
      "uint256 chainId",
      "address verifyingContract",
      "bytes32 salt",
      "uint256[] extensions",
    ]);
  });

  test("the registry fragment holds no write beyond the four the allowlist names", () => {
    const writes = identityRegistryAbi
      .filter((i) => i.type === "function" && i.stateMutability !== "view")
      .map((i) => (i.type === "function" ? toFunctionSelector(i) : ""));
    expect(writes.sort()).toEqual(["0x1aa3a008", "0x2d1ef5ae", "0x466648da", "0xf2c298be"]);
    const mutability = identityRegistryAbi.map((i) => (i.type === "function" ? i.stateMutability : "event"));
    expect(new Set(mutability)).toEqual(new Set(["nonpayable", "view", "event"]));
  });

  test("the factory fragment holds the pointer step's three reads, all views", () => {
    expect(
      legalBodyFactoryAbi.map((i) => `${i.name}(${i.inputs.map((p) => p.type).join(",")})`),
    ).toEqual(["encodePointer(address)", "linkedLegalBody(uint256)", "identityOwnerAtCreation(address)"]);
    expect(legalBodyFactoryAbi.every((i) => i.stateMutability === "view")).toBe(true);
  });
});

describe("the pointer", () => {
  test("for chain 5042002 and the live body it is the value on chain, 96 bytes", () => {
    const p = encodePointer(CHAIN, LIVE_BODY);
    expect(p).toBe(LIVE_POINTER);
    expect((p.length - 2) / 2).toBe(96);
  });

  test("the body's casing does not change the encoding", () => {
    expect(encodePointer(CHAIN, lower(LIVE_BODY))).toBe(LIVE_POINTER);
  });

  test("pointerMatchesFactory compares without regard to case", () => {
    const local = encodePointer(CHAIN, LIVE_BODY);
    expect(pointerMatchesFactory(local, LIVE_POINTER)).toBe(true);
    expect(pointerMatchesFactory(local, upper(LIVE_POINTER) as Hex)).toBe(true);
    expect(pointerMatchesFactory(upper(local) as Hex, LIVE_POINTER)).toBe(true);
  });

  test("pointerMatchesFactory refuses another chain's value, another body, a cut value", () => {
    const local = encodePointer(CHAIN, LIVE_BODY);
    expect(pointerMatchesFactory(local, encodePointer(OTHER_CHAIN, LIVE_BODY))).toBe(false);
    expect(pointerMatchesFactory(local, encodePointer(CHAIN, ANOTHER_BODY))).toBe(false);
    expect(pointerMatchesFactory(local, local.slice(0, -2) as Hex)).toBe(false);
    expect(pointerMatchesFactory(local, "0x")).toBe(false);
  });

  test("a native amount reads with 18 decimals", () => {
    expect(formatNative(BigInt("10000000000000000"))).toBe("0.01");
    expect(formatNative(BigInt("1000000000000000000"))).toBe("1");
    expect(formatNative(BigInt(0))).toBe("0");
  });
});

describe("walletKindOf", () => {
  const delegation = `0xef0100${"12".repeat(20)}` as Hex;
  test.each<[string, Hex | undefined, string]>([
    ["no code read", undefined, "key"],
    ["an empty code", "0x", "key"],
    ["a 23-byte delegation", delegation, "delegated"],
    ["a 23-byte delegation in upper case", upper(delegation) as Hex, "delegated"],
    ["23 bytes with another prefix", `0xef0200${"12".repeat(20)}`, "contract"],
    ["a delegation prefix on 24 bytes", `${delegation}00`, "contract"],
    ["a contract's code", `0x6080604052${"00".repeat(200)}`, "contract"],
  ])("%s", (_name, code, kind) => {
    expect(walletKindOf(code)).toBe(kind);
  });
});

describe("the request builders", () => {
  test("registerCall without a URI is register()", () => {
    expect(registerCall(config, null)).toEqual({
      chainId: CHAIN,
      address: REGISTRY,
      abi: identityRegistryAbi,
      functionName: "register",
      args: [],
    });
    expect(registerCall(config, null).abi).toBe(identityRegistryAbi);
  });

  test("registerCall with a URI is register(string)", () => {
    expect(registerCall(config, "https://example.com/agent.json")).toEqual({
      chainId: CHAIN,
      address: REGISTRY,
      abi: identityRegistryAbi,
      functionName: "register",
      args: ["https://example.com/agent.json"],
    });
  });

  test("pointerCall writes the order's own pointer under the pinned key", () => {
    expect(pointerCall(config, order())).toEqual({
      chainId: CHAIN,
      address: REGISTRY,
      abi: identityRegistryAbi,
      functionName: "setMetadata",
      args: [BigInt(LIVE_AGENT), "legalBody", LIVE_POINTER],
    });
  });

  test.each<[string, Partial<LegalBodyOrderView>]>([
    ["no identity", { agentId: null }],
    ["no body", { bodyAddress: null }],
    ["an identity that is not a canonical decimal", { agentId: "0x1" }],
    ["a body that is not an address", { bodyAddress: "0x1234" }],
  ])("pointerCall refuses an order with %s", (_name, over) => {
    expect(pointerCall(config, order(over))).toEqual({ ok: false, problem: "order_has_no_body" });
  });

  test("agentWalletCall writes the agent's wallet on the identity, on the configured registry", () => {
    const req = agentWalletCall(config, {
      agentId: LIVE_AGENT,
      newWallet: OTHER_WALLET,
      deadline: DEADLINE,
      signature: SIGNATURE,
    });
    expect(req).toEqual(goodWallet());
    expect(req.abi).toBe(identityRegistryAbi);
  });
});

describe("allowedCall accepts", () => {
  test("register(): the calldata is the bare selector", () => {
    expect(allowedCall(registerCall(config, null), { config, order: null })).toEqual({
      ok: true,
      data: "0x1aa3a008",
    });
  });

  test("register(string): the calldata starts with its selector", () => {
    const out = allowedCall(registerCall(config, "https://example.com/agent.json"), {
      config,
      order: null,
    });
    if (!out.ok) throw new Error(out.problem);
    expect(out.data.slice(0, 10)).toBe("0xf2c298be");
    expect(out.data).toBe(
      encodeFunctionData({
        abi: identityRegistryAbi,
        functionName: "register",
        args: ["https://example.com/agent.json"],
      }),
    );
  });

  test("the pointer: the calldata starts with setMetadata's selector and says what it writes", () => {
    const out = allowedCall(goodPointer(), ctx);
    if (!out.ok) throw new Error(out.problem);
    expect(out.data.slice(0, 10)).toBe("0x466648da");
    const decoded = decodeFunctionData({ abi: identityRegistryAbi, data: out.data });
    expect(decoded.functionName).toBe("setMetadata");
    expect(decoded.args).toEqual([BigInt(LIVE_AGENT), "legalBody", LIVE_POINTER]);
  });

  test("the pointer for a body whose pointer was cleared", () => {
    const broken = order({ state: "broken", brokenReason: "not_linked" });
    expect(allowedCall(goodPointer(), { config, order: broken }).ok).toBe(true);
  });

  test("addresses and the pointer in another case", () => {
    const req = goodPointer();
    const mixed: WriteRequest = {
      ...req,
      address: lower(REGISTRY),
      args: [BigInt(LIVE_AGENT), "legalBody", upper(LIVE_POINTER)],
    };
    const shouted = order({ factory: upper(FACTORY), bodyAddress: lower(LIVE_BODY) });
    expect(allowedCall(mixed, { config, order: shouted }).ok).toBe(true);
  });

  test("a zero value", () => {
    expect(allowedCall({ ...registerCall(config, null), value: BigInt(0) }, ctx).ok).toBe(true);
  });

  test("setAgentWallet: the calldata is the pinned ABI's encoding of the four arguments", () => {
    const out = allowedCall(goodWallet(), walletCtx());
    if (!out.ok) throw new Error(out.problem);
    expect(out.data).toBe(walletData());
    expect(out.data.slice(0, 10)).toBe("0x2d1ef5ae");
    const decoded = decodeFunctionData({ abi: identityRegistryAbi, data: out.data });
    expect(decoded.functionName).toBe("setAgentWallet");
    expect(decoded.args).toEqual([BigInt(LIVE_AGENT), OTHER_WALLET, DEADLINE, SIGNATURE]);
  });

  test("setAgentWallet needs no order, and an order selected changes nothing", () => {
    expect(allowedCall(goodWallet(), { ...walletCtx(), order: order() })).toEqual({
      ok: true,
      data: walletData(),
    });
    expect(allowedCall(goodWallet(), { ...walletCtx(), order: order({ state: "draft" }) }).ok).toBe(true);
  });

  test("setAgentWallet at both ends of the window: the chain's time, and 300 seconds after", () => {
    expect(allowedCall(walletWith(2, BigInt(NOW)), walletCtx()).ok).toBe(true);
    expect(allowedCall(walletWith(2, BigInt(NOW + 300)), walletCtx()).ok).toBe(true);
  });

  test("setAgentWallet with a chain time that has a fraction of a second", () => {
    expect(allowedCall(goodWallet(), walletCtx({ nowSeconds: NOW + 0.5 })).ok).toBe(true);
    expect(allowedCall(walletWith(2, BigInt(NOW + 1)), walletCtx({ nowSeconds: NOW + 0.5 })).ok).toBe(true);
    expect(allowedCall(walletWith(2, BigInt(NOW + 300)), walletCtx({ nowSeconds: NOW + 0.5 })).ok).toBe(true);
  });

  test("setAgentWallet with a chain time of 0, the lowest a context may carry", () => {
    expect(allowedCall(walletWith(2, BigInt(0)), walletCtx({ nowSeconds: 0 })).ok).toBe(true);
  });

  test("setAgentWallet for the highest identity a uint256 holds", () => {
    const highest = BigInt(2) ** BigInt(256) - BigInt(1);
    expect(allowedCall(walletWith(0, highest), walletCtx({ agentId: highest.toString() })).ok).toBe(true);
  });

  test("setAgentWallet with a signature of 2,048 bytes, and with one of a single byte", () => {
    expect(allowedCall(walletWith(3, `0x${"5a".repeat(2048)}`), walletCtx()).ok).toBe(true);
    expect(allowedCall(walletWith(3, "0x5a"), walletCtx()).ok).toBe(true);
  });

  test("setAgentWallet with the wallet and the signature in another case: the same calldata", () => {
    const same = { ok: true, data: walletData() };
    expect(allowedCall(walletWith(1, lower(OTHER_WALLET)), walletCtx())).toEqual(same);
    expect(allowedCall(walletWith(1, upper(OTHER_WALLET)), walletCtx())).toEqual(same);
    expect(allowedCall(walletWith(3, upper(SIGNATURE)), walletCtx())).toEqual(same);
    expect(allowedCall(goodWallet(), walletCtx({ guardian: lower(GUARDIAN) }))).toEqual(same);
  });
});

describe("allowedCall refuses", () => {
  const good = goodPointer();
  const reg = registerCall(config, "https://example.com/agent.json");
  const wallet = goodWallet();
  const agent = BigInt(LIVE_AGENT);
  const cases: [string, WriteRequest, CallContext, string][] = [
    ["a call that sends value", { ...good, value: BigInt(1) }, ctx, "sends_value"],
    ["a register that sends value", { ...reg, value: BigInt(1) }, ctx, "sends_value"],
    ["another chain", { ...good, chainId: OTHER_CHAIN }, ctx, "wrong_chain"],
    ["another contract", { ...good, address: ANOTHER_CONTRACT }, ctx, "not_the_registry"],
    [
      "an ABI equal to the pinned one but not it",
      { ...good, abi: [...identityRegistryAbi] as unknown as typeof identityRegistryAbi },
      ctx,
      "not_the_pinned_abi",
    ],
    ["register with two arguments", { ...reg, args: ["a", "b"] }, ctx, "register_args"],
    ["register with a number", { ...reg, args: [BigInt(1)] }, ctx, "register_args"],
    ["register whose arguments are not a list", { ...reg, args: "https://example.com" as unknown as unknown[] }, ctx, "register_args"],
    ["a pointer with no order selected", good, { config, order: null }, "no_order"],
    [
      "a pointer for an order on another chain",
      good,
      { config, order: order({ chainId: OTHER_CHAIN }) },
      "order_on_another_deployment",
    ],
    [
      "a pointer for an order of another factory",
      good,
      { config, order: order({ factory: ANOTHER_FACTORY }) },
      "order_on_another_deployment",
    ],
    ["a pointer at a draft", good, { config, order: order({ state: "draft" }) }, "order_not_pointable"],
    ["a pointer at a reservation", good, { config, order: order({ state: "reserved" }) }, "order_not_pointable"],
    ["a pointer at a linked body", good, { config, order: order({ state: "linked" }) }, "order_not_pointable"],
    [
      "a pointer at a replaced body",
      good,
      { config, order: order({ state: "broken", brokenReason: "replaced" }) },
      "order_not_pointable",
    ],
    [
      "a pointer at a body winding down",
      good,
      { config, order: order({ state: "broken", brokenReason: "winding_down" }) },
      "order_not_pointable",
    ],
    [
      "a pointer while broken with no served reason",
      good,
      { config, order: order({ state: "broken", brokenReason: null }) },
      "order_not_pointable",
    ],
    [
      "a pointer at a superseded body",
      good,
      { config, order: order({ state: "superseded", brokenReason: "not_linked" }) },
      "order_not_pointable",
    ],
    ["a pointer at a revoked body", good, { config, order: order({ revoked: true }) }, "order_not_pointable"],
    [
      "a pointer at a revoked body whose pointer was cleared",
      good,
      { config, order: order({ state: "broken", brokenReason: "not_linked", revoked: true }) },
      "order_not_pointable",
    ],
    ["a pointer for an order with no identity", good, { config, order: order({ agentId: null }) }, "order_has_no_body"],
    ["a pointer for an order with no body", good, { config, order: order({ bodyAddress: null }) }, "order_has_no_body"],
    [
      "a pointer for an order whose identity is not a canonical decimal",
      good,
      { config, order: order({ agentId: "" }) },
      "order_has_no_body",
    ],
    [
      "a pointer for an order whose body is not an address",
      good,
      { config, order: order({ bodyAddress: "0xb0d1e" }) },
      "order_has_no_body",
    ],
    ["setMetadata with two arguments", { ...good, args: [agent, "legalBody"] }, ctx, "set_metadata_args"],
    [
      "setMetadata with four arguments",
      { ...good, args: [agent, "legalBody", LIVE_POINTER, "0x"] },
      ctx,
      "set_metadata_args",
    ],
    ["setMetadata whose arguments are not a list", { ...good, args: undefined as unknown as unknown[] }, ctx, "set_metadata_args"],
    ["a pointer for another identity", { ...good, args: [BigInt(1), "legalBody", LIVE_POINTER] }, ctx, "other_identity"],
    ["an identity as a string", { ...good, args: [LIVE_AGENT, "legalBody", LIVE_POINTER] }, ctx, "other_identity"],
    ["another metadata key", { ...good, args: [agent, "agentWallet", LIVE_POINTER] }, ctx, "other_key"],
    ["the key in another case", { ...good, args: [agent, "LegalBody", LIVE_POINTER] }, ctx, "other_key"],
    [
      "a pointer at another body",
      { ...good, args: [agent, "legalBody", encodePointer(CHAIN, ANOTHER_BODY)] },
      ctx,
      "other_body",
    ],
    [
      "a pointer that names another chain",
      { ...good, args: [agent, "legalBody", encodePointer(OTHER_CHAIN, LIVE_BODY)] },
      ctx,
      "other_body",
    ],
    ["a pointer value that is not a string", { ...good, args: [agent, "legalBody", BigInt(1)] }, ctx, "other_body"],
    ["setAgentWallet that sends value", { ...wallet, value: BigInt(1) }, walletCtx(), "sends_value"],
    ["setAgentWallet on another chain", { ...wallet, chainId: OTHER_CHAIN }, walletCtx(), "wrong_chain"],
    ["setAgentWallet to another contract", { ...wallet, address: ANOTHER_CONTRACT }, walletCtx(), "not_the_registry"],
    [
      "setAgentWallet over an ABI equal to the pinned one but not it",
      { ...wallet, abi: [...identityRegistryAbi] as unknown as typeof identityRegistryAbi },
      walletCtx(),
      "not_the_pinned_abi",
    ],
    ["setAgentWallet with no wallet context", wallet, { config, order: null }, "no_wallet_context"],
    ["setAgentWallet with an order but no wallet context", wallet, ctx, "no_wallet_context"],
    [
      "setAgentWallet with a context that names no guardian",
      wallet,
      walletCtx({ guardian: undefined as unknown as Address }),
      "no_wallet_context",
    ],
    ["setAgentWallet with a null guardian", wallet, walletCtx({ guardian: null as unknown as Address }), "no_wallet_context"],
    ["setAgentWallet with an empty guardian", wallet, walletCtx({ guardian: "" as Address }), "no_wallet_context"],
    [
      "setAgentWallet with a guardian that is not an address",
      wallet,
      walletCtx({ guardian: "0x1234" as Address }),
      "no_wallet_context",
    ],
    [
      "setAgentWallet with a context that names no identity",
      wallet,
      walletCtx({ agentId: undefined as unknown as string }),
      "no_wallet_context",
    ],
    [
      "setAgentWallet with a context identity as a number",
      wallet,
      walletCtx({ agentId: Number(LIVE_AGENT) as unknown as string }),
      "no_wallet_context",
    ],
    [
      "setAgentWallet with a context that has no chain time",
      wallet,
      walletCtx({ nowSeconds: undefined as unknown as number }),
      "no_wallet_context",
    ],
    ["a chain time that could not be read", wallet, walletCtx({ nowSeconds: Number.NaN }), "no_wallet_context"],
    ["an infinite chain time", wallet, walletCtx({ nowSeconds: Number.POSITIVE_INFINITY }), "no_wallet_context"],
    ["a chain time below 0", wallet, walletCtx({ nowSeconds: -1 }), "no_wallet_context"],
    [
      "a chain time as a string",
      wallet,
      walletCtx({ nowSeconds: String(NOW) as unknown as number }),
      "no_wallet_context",
    ],
    ["setAgentWallet with three arguments", { ...wallet, args: wallet.args.slice(0, 3) }, walletCtx(), "set_agent_wallet_args"],
    ["setAgentWallet with five arguments", { ...wallet, args: [...wallet.args, "0x"] }, walletCtx(), "set_agent_wallet_args"],
    [
      "setAgentWallet whose arguments are not a list",
      { ...wallet, args: null as unknown as unknown[] },
      walletCtx(),
      "set_agent_wallet_args",
    ],
    ["setAgentWallet with the identity as a string", walletWith(0, LIVE_AGENT), walletCtx(), "set_agent_wallet_args"],
    ["setAgentWallet with a wallet that is not an address", walletWith(1, "0x1234"), walletCtx(), "set_agent_wallet_args"],
    ["setAgentWallet with a wallet that is not a string", walletWith(1, BigInt(1)), walletCtx(), "set_agent_wallet_args"],
    ["setAgentWallet with the deadline as a number", walletWith(2, NOW + 270), walletCtx(), "set_agent_wallet_args"],
    ["setAgentWallet with a signature that is not a string", walletWith(3, new Uint8Array(65)), walletCtx(), "set_agent_wallet_args"],
    ["the wallet of another identity", walletWith(0, BigInt(1)), walletCtx(), "other_identity"],
    [
      "a context whose identity is the same number in hex",
      wallet,
      walletCtx({ agentId: `0x${BigInt(LIVE_AGENT).toString(16)}` }),
      "other_identity",
    ],
    ["a context whose identity is not a number", wallet, walletCtx({ agentId: "agent" }), "other_identity"],
    ["the zero address as the agent's wallet", walletWith(1, ZERO), walletCtx(), "wallet_is_zero"],
    ["the guardian's own wallet as the agent's", walletWith(1, GUARDIAN), walletCtx(), "wallet_is_guardian"],
    ["the guardian's own wallet in lower case", walletWith(1, lower(GUARDIAN)), walletCtx(), "wallet_is_guardian"],
    [
      "a deadline one second before the chain's time",
      walletWith(2, BigInt(NOW - 1)),
      walletCtx(),
      "deadline_out_of_window",
    ],
    [
      "a deadline 301 seconds after the chain's time",
      walletWith(2, BigInt(NOW + 301)),
      walletCtx(),
      "deadline_out_of_window",
    ],
    [
      "a deadline far past any uint256",
      walletWith(2, BigInt(2) ** BigInt(256)),
      walletCtx(),
      "deadline_out_of_window",
    ],
    [
      "a deadline at the chain's whole second, when the time is half a second past it",
      walletWith(2, BigInt(NOW)),
      walletCtx({ nowSeconds: NOW + 0.5 }),
      "deadline_out_of_window",
    ],
    [
      "a deadline 301 seconds after the chain's whole second, when the time is half a second past it",
      walletWith(2, BigInt(NOW + 301)),
      walletCtx({ nowSeconds: NOW + 0.5 }),
      "deadline_out_of_window",
    ],
    ["an empty signature", walletWith(3, "0x"), walletCtx(), "signature_shape"],
    ["a signature with an odd digit", walletWith(3, `${SIGNATURE}5`), walletCtx(), "signature_shape"],
    ["a signature that is not hex", walletWith(3, `0x${"zz".repeat(65)}`), walletCtx(), "signature_shape"],
    ["a signature with no 0x", walletWith(3, "5a".repeat(65)), walletCtx(), "signature_shape"],
    ["a signature of 2,049 bytes", walletWith(3, `0x${"5a".repeat(2049)}`), walletCtx(), "signature_shape"],
    [
      "a function outside the list",
      { ...good, functionName: "transferFrom" as unknown as WriteRequest["functionName"] },
      ctx,
      "not_allowed",
    ],
    [
      "a view of the pinned fragment, sent as a write",
      { ...wallet, functionName: "eip712Domain" as unknown as WriteRequest["functionName"], args: [] },
      walletCtx(),
      "not_allowed",
    ],
  ];

  test.each(cases)("%s", (_name, req, c, problem) => {
    expect(allowedCall(req, c)).toEqual({ ok: false, problem });
  });

  test("covers every problem the allowlist can name", () => {
    expect(new Set(cases.map((c) => c[3]))).toEqual(
      new Set([
        "sends_value",
        "wrong_chain",
        "not_the_registry",
        "not_the_pinned_abi",
        "register_args",
        "no_order",
        "order_on_another_deployment",
        "order_not_pointable",
        "order_has_no_body",
        "set_metadata_args",
        "other_identity",
        "other_key",
        "other_body",
        "no_wallet_context",
        "set_agent_wallet_args",
        "wallet_is_zero",
        "wallet_is_guardian",
        "deadline_out_of_window",
        "signature_shape",
        "not_allowed",
      ]),
    );
  });

  test("the first rule broken names the problem, in the order the rules are written", () => {
    const stranger = order({ factory: ANOTHER_FACTORY, state: "linked", agentId: null });
    const everything: WriteRequest = {
      ...good,
      value: BigInt(1),
      chainId: OTHER_CHAIN,
      address: ANOTHER_CONTRACT,
      abi: [...identityRegistryAbi] as unknown as typeof identityRegistryAbi,
      args: [BigInt(1), "agentWallet"],
    };
    const steps: [WriteRequest, CallContext, string][] = [
      [everything, { config, order: stranger }, "sends_value"],
      [{ ...everything, value: undefined }, { config, order: stranger }, "wrong_chain"],
      [{ ...everything, value: undefined, chainId: CHAIN }, { config, order: stranger }, "not_the_registry"],
      [
        { ...everything, value: undefined, chainId: CHAIN, address: REGISTRY },
        { config, order: stranger },
        "not_the_pinned_abi",
      ],
      [{ ...good, args: [BigInt(1), "agentWallet"] }, { config, order: null }, "no_order"],
      [{ ...good, args: [BigInt(1), "agentWallet"] }, { config, order: stranger }, "order_on_another_deployment"],
      [
        { ...good, args: [BigInt(1), "agentWallet"] },
        { config, order: order({ state: "linked", agentId: null }) },
        "order_not_pointable",
      ],
      [{ ...good, args: [BigInt(1), "agentWallet"] }, { config, order: order({ agentId: null }) }, "order_has_no_body"],
      [{ ...good, args: [BigInt(1), "agentWallet"] }, ctx, "set_metadata_args"],
      [{ ...good, args: [BigInt(1), "agentWallet", "0x"] }, ctx, "other_identity"],
      [{ ...good, args: [agent, "agentWallet", "0x"] }, ctx, "other_key"],
      [{ ...good, args: [agent, "legalBody", "0x"] }, ctx, "other_body"],
    ];
    for (const [req, c, problem] of steps) expect(allowedCall(req, c)).toEqual({ ok: false, problem });
  });

  test("setAgentWallet: the general rules first, then its own, in the order they are written", () => {
    const early = BigInt(NOW - 1);
    const everything: WriteRequest = {
      ...wallet,
      value: BigInt(1),
      chainId: OTHER_CHAIN,
      address: ANOTHER_CONTRACT,
      abi: [...identityRegistryAbi] as unknown as typeof identityRegistryAbi,
      args: [LIVE_AGENT],
    };
    const noWallet: CallContext = { config, order: null };
    const steps: [WriteRequest, CallContext, string][] = [
      [everything, noWallet, "sends_value"],
      [{ ...everything, value: undefined }, noWallet, "wrong_chain"],
      [{ ...everything, value: undefined, chainId: CHAIN }, noWallet, "not_the_registry"],
      [{ ...everything, value: undefined, chainId: CHAIN, address: REGISTRY }, noWallet, "not_the_pinned_abi"],
      [{ ...wallet, args: [LIVE_AGENT] }, noWallet, "no_wallet_context"],
      [
        { ...wallet, args: [LIVE_AGENT] },
        walletCtx({ guardian: undefined as unknown as Address }),
        "no_wallet_context",
      ],
      [{ ...wallet, args: [LIVE_AGENT] }, walletCtx(), "set_agent_wallet_args"],
      [{ ...wallet, args: [BigInt(1), ZERO, early, "0x"] }, walletCtx(), "other_identity"],
      [{ ...wallet, args: [agent, ZERO, early, "0x"] }, walletCtx(), "wallet_is_zero"],
      // A zero guardian makes the zero address both: the zero rule comes first.
      [{ ...wallet, args: [agent, ZERO, early, "0x"] }, walletCtx({ guardian: ZERO }), "wallet_is_zero"],
      [{ ...wallet, args: [agent, GUARDIAN, early, "0x"] }, walletCtx(), "wallet_is_guardian"],
      [{ ...wallet, args: [agent, OTHER_WALLET, early, "0x"] }, walletCtx(), "deadline_out_of_window"],
      [{ ...wallet, args: [agent, OTHER_WALLET, DEADLINE, "0x"] }, walletCtx(), "signature_shape"],
    ];
    for (const [req, c, problem] of steps) expect(allowedCall(req, c)).toEqual({ ok: false, problem });
  });

  test("setAgentWallet never throws on a number past a uint256: it refuses", () => {
    const limit = BigInt(2) ** BigInt(256);
    // A 78-digit context id at 2^256, repeated by the request: it passes the decimal pattern.
    expect(limit.toString()).toHaveLength(78);
    const high = walletWith(0, limit);
    const highCtx = walletCtx({ agentId: limit.toString() });
    expect(() => allowedCall(high, highCtx)).not.toThrow();
    expect(allowedCall(high, highCtx)).toEqual({ ok: false, problem: "other_identity" });
    // A huge but finite chain time: any deadline in its window is past a uint256.
    const far = walletWith(2, BigInt(1e80));
    const farCtx = walletCtx({ nowSeconds: 1e80 });
    expect(() => allowedCall(far, farCtx)).not.toThrow();
    expect(allowedCall(far, farCtx)).toEqual({ ok: false, problem: "deadline_out_of_window" });
  });
});

describe("sendAllowedCall", () => {
  const req = goodPointer();
  const wallet = () => vi.fn<(req: WriteRequest) => Promise<Hex>>(async () => "0xabc");

  test("a wallet on another chain: no prompt, never a silent switch", async () => {
    const writeContract = wallet();
    expect(
      await sendAllowedCall(req, ctx, { walletChainId: 1, configuredChainIds: [CHAIN], writeContract }),
    ).toEqual({ ok: false, problem: "wallet_on_another_chain" });
    expect(
      await sendAllowedCall(req, ctx, {
        walletChainId: undefined,
        configuredChainIds: [CHAIN],
        writeContract,
      }),
    ).toEqual({ ok: false, problem: "wallet_on_another_chain" });
    expect(writeContract).not.toHaveBeenCalled();
  });

  test("a chain this site is not configured for: no prompt", async () => {
    const writeContract = wallet();
    expect(
      await sendAllowedCall(req, ctx, {
        walletChainId: CHAIN,
        configuredChainIds: [OTHER_CHAIN],
        writeContract,
      }),
    ).toEqual({ ok: false, problem: "chain_not_configured" });
    // Checked before the wallet's chain.
    expect(
      await sendAllowedCall(req, ctx, { walletChainId: 1, configuredChainIds: [], writeContract }),
    ).toEqual({ ok: false, problem: "chain_not_configured" });
    expect(writeContract).not.toHaveBeenCalled();
  });

  test("a refused call never reaches the wallet, and the allowlist speaks first", async () => {
    const writeContract = wallet();
    const bad: WriteRequest = { ...req, args: [BigInt(LIVE_AGENT), "legalBody", encodePointer(CHAIN, ANOTHER_BODY)] };
    expect(
      await sendAllowedCall(bad, ctx, { walletChainId: CHAIN, configuredChainIds: [CHAIN], writeContract }),
    ).toEqual({ ok: false, problem: "other_body" });
    expect(
      await sendAllowedCall(bad, ctx, { walletChainId: 1, configuredChainIds: [], writeContract }),
    ).toEqual({ ok: false, problem: "other_body" });
    expect(writeContract).not.toHaveBeenCalled();
  });

  test("an allowed call is sent once, its gas passed through untouched", async () => {
    const writeContract = wallet();
    const gas = BigInt(123_456);
    const withGas: WriteRequest = { ...req, gas };
    const out = await sendAllowedCall(withGas, ctx, {
      walletChainId: CHAIN,
      configuredChainIds: [CHAIN],
      writeContract,
    });
    const checked = allowedCall(withGas, ctx);
    if (!checked.ok) throw new Error(checked.problem);
    expect(out).toEqual({ ok: true, hash: "0xabc", data: checked.data });
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(writeContract).toHaveBeenCalledWith(withGas);
    const sent = writeContract.mock.calls[0][0];
    expect(sent.gas).toBe(gas);
    expect(sent.abi).toBe(identityRegistryAbi);
  });

  test("a register is sent as built, without a gas it was not given", async () => {
    const writeContract = wallet();
    const reg = registerCall(config, null);
    const out = await sendAllowedCall(reg, { config, order: null }, {
      walletChainId: CHAIN,
      configuredChainIds: [CHAIN],
      writeContract,
    });
    expect(out).toEqual({ ok: true, hash: "0xabc", data: "0x1aa3a008" });
    expect(writeContract).toHaveBeenCalledWith(reg);
    expect("gas" in writeContract.mock.calls[0][0]).toBe(false);
  });

  test("the wallet gets the arguments the allowlist checked, not the caller's array", async () => {
    // wagmi reads the request's variables a tick later, after its own `onMutate`.
    let seen: readonly unknown[] = [];
    const writeContract = vi.fn<(r: WriteRequest) => Promise<Hex>>(async (r) => {
      await Promise.resolve();
      seen = [...r.args];
      return "0xabc";
    });
    const args: unknown[] = [BigInt(LIVE_AGENT), "legalBody", LIVE_POINTER];
    const pending = sendAllowedCall({ ...req, args }, ctx, {
      walletChainId: CHAIN,
      configuredChainIds: [CHAIN],
      writeContract,
    });
    args[2] = encodePointer(CHAIN, ANOTHER_BODY);
    expect((await pending).ok).toBe(true);
    expect(seen).toEqual([BigInt(LIVE_AGENT), "legalBody", LIVE_POINTER]);
    expect(writeContract.mock.calls[0][0].args).not.toBe(args);
  });

  test("setAgentWallet: the wallet gets exactly the four arguments the allowlist checked", async () => {
    let seen: readonly unknown[] = [];
    const writeContract = vi.fn<(r: WriteRequest) => Promise<Hex>>(async (r) => {
      await Promise.resolve();
      seen = [...r.args];
      return "0xabc";
    });
    // The wallet in lower case and the signature in upper: forwarded as checked, checksummed and
    // in lower case.
    const args: unknown[] = [BigInt(LIVE_AGENT), lower(OTHER_WALLET), DEADLINE, upper(SIGNATURE)];
    const padded = { ...goodWallet(), args, dataSuffix: "0xdeadbeef" } as WriteRequest;
    const pending = sendAllowedCall(padded, walletCtx(), {
      walletChainId: CHAIN,
      configuredChainIds: [CHAIN],
      writeContract,
    });
    args[1] = ANOTHER_CONTRACT;
    args.push("0x");
    expect(await pending).toEqual({ ok: true, hash: "0xabc", data: walletData() });
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(writeContract).toHaveBeenCalledWith(goodWallet());
    expect(seen).toEqual([BigInt(LIVE_AGENT), OTHER_WALLET, DEADLINE, SIGNATURE]);
    expect(writeContract.mock.calls[0][0].args).not.toBe(args);
    expect(Object.keys(writeContract.mock.calls[0][0]).sort()).toEqual(
      ["abi", "address", "args", "chainId", "functionName"].sort(),
    );
  });

  test("a refused setAgentWallet never reaches the wallet", async () => {
    const writeContract = wallet();
    expect(
      await sendAllowedCall(walletWith(1, GUARDIAN), walletCtx(), {
        walletChainId: CHAIN,
        configuredChainIds: [CHAIN],
        writeContract,
      }),
    ).toEqual({ ok: false, problem: "wallet_is_guardian" });
    expect(writeContract).not.toHaveBeenCalled();
  });

  test("only the checked fields reach the wallet", async () => {
    const writeContract = wallet();
    const padded = { ...req, dataSuffix: "0xdeadbeef", nonce: 7 } as WriteRequest;
    await sendAllowedCall(padded, ctx, { walletChainId: CHAIN, configuredChainIds: [CHAIN], writeContract });
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(writeContract).toHaveBeenCalledWith(req);
    expect(Object.keys(writeContract.mock.calls[0][0]).sort()).toEqual(
      ["abi", "address", "args", "chainId", "functionName"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The company's pot: the setup and the guardian's Safe actions
// ---------------------------------------------------------------------------------------------

/** The real run of 24 Nov on Arc testnet: the guardian, the agent's key, the payee (the "new key"
 *  of V12 and V13), the salt nonce, and the Safe it created, the pot the guardian's actions go to. */
const G = "0x15D4EE6F84b6bf8ceE5A24cCb19FDF8257c22b0A" as const;
const A = "0x2dDcf8da463526614b9FA5E87Db259a3Bf06667C" as const;
const P = "0xE886e729CC5C43bE28642827C4e72e660A83C7E8" as const;
const SALT = BigInt("72231338869903870587851170785833461215");
const REAL_SAFE = "0x0bbBa174c1D6b6Edd2F1A86ff5af435B645b77EF" as const;
/** V3's pot with salt nonce 1: the address V4 and V5 create. */
const V3_POT = "0x4A13bC20E8596009CA37B897Aaf654C5e0b8e87D" as const;
/** An invention: some other Safe module. */
const OTHER_MODULE = "0x00000000000000000000000000000000000c0de2" as const;
const T = potAddresses(CHAIN) as PotAddresses;
const NO_WEI = BigInt(0);
const MAX_UINT256 = BigInt(2) ** BigInt(256) - BigInt(1);
const SETUP_GAS = BigInt(650_000);
const EXEC_GAS = BigInt(200_000);

type Setup = Extract<PotCallContext, { kind: "setup" }>;
type Change = Extract<PotCallContext, { kind: "change" }>;
type Stop = Extract<PotCallContext, { kind: "stop" }>;
type Withdraw = Extract<PotCallContext, { kind: "withdraw" }>;
type Restore = Extract<PotCallContext, { kind: "restore" }>;
type Exec = Change | Stop | Withdraw | Restore;

/** V5: 50 USDC in each thirty-day period, salt nonce 1, 60 USDC for the pot and 0.1 USDC of fee
 *  money for the agent's key. */
const SETUP_V5: Setup = {
  kind: "setup",
  guardian: G,
  agentWallet: A,
  ceilingUnits: BigInt(50_000_000),
  saltNonce: BigInt(1),
  fundWei: BigInt("60000000000000000000"),
  agentGasWei: BigInt("100000000000000000"),
};
/** V4: the same pot, with no money. */
const SETUP_V4: Setup = { ...SETUP_V5, fundWei: NO_WEI, agentGasWei: NO_WEI };
/** V6: the ceiling changed to 20 USDC. */
const CHANGE_V6: Change = {
  kind: "change",
  pot: REAL_SAFE,
  guardian: G,
  agentWallet: A,
  ceilingUnits: BigInt(20_000_000),
};
/** V9: the stop of a running pot. */
const STOP_V9: Stop = {
  kind: "stop",
  pot: REAL_SAFE,
  guardian: G,
  delegates: [A],
  modules: [T.allowanceModule],
};
/** V10: 3 USDC back to the guardian, once the add-on is off. */
const WITHDRAW_V10: Withdraw = {
  kind: "withdraw",
  pot: REAL_SAFE,
  guardian: G,
  modules: [],
  balanceWei: BigInt("3000000000000000000"),
};
/** V11: start again on a stopped pot, 50 USDC. */
const RESTORE_V11: Restore = {
  kind: "restore",
  pot: REAL_SAFE,
  guardian: G,
  agentWallet: A,
  ceilingUnits: BigInt(50_000_000),
  delegates: [],
  modules: [],
};
/** V12: a new key on a running pot. */
const RESTORE_V12: Restore = { ...RESTORE_V11, agentWallet: P, delegates: [A], modules: [T.allowanceModule] };
/** V13: a new key on a stopped pot. */
const RESTORE_V13: Restore = { ...RESTORE_V11, agentWallet: P };

/** The order of a linked legal body whose guardian is the real run's. */
const linked = (over: Partial<LegalBodyOrderView> = {}) => order({ state: "linked", guardian: G, ...over });

/** What the allowlist reads for a pot call: the order linked, and the pot's facts of the click. */
const potCtx = (pot: PotCallContext, over: Partial<CallContext> = {}): CallContext => ({
  config,
  order: linked(),
  pot,
  ...over,
});

/** A context the type would refuse: what a screen with a bug could still hand over. */
const odd = (p: Record<string, unknown>): PotCallContext => p as unknown as PotCallContext;

const refused = (problem: string) => ({ ok: false, problem });

/** The setup's request, as a screen builds it. */
function setupReq(p: Setup = SETUP_V5, gas: bigint = SETUP_GAS): WriteRequest {
  const req = potSetupCall(config, p, gas);
  if ("ok" in req) throw new Error(`the setup was refused: ${req.problem}`);
  return req;
}

/** A guardian's action, as a screen builds it. */
function execReq(p: Exec, gas: bigint = EXEC_GAS): WriteRequest {
  const req = potExecCall(config, p, gas);
  if ("ok" in req) throw new Error(`the action was refused: ${req.problem}`);
  return req;
}

/** The setup's calls, each a copy a test may change. */
const callsOf = (req: WriteRequest): Call3Value[] =>
  (req.args[0] as Call3Value[]).map((c) => ({ ...c }));

/** V5's request with its calls edited; its value stays the sum the allowlist rebuilds. */
const setupWithCalls = (edit: (calls: Call3Value[]) => Call3Value[]): WriteRequest => {
  const req = setupReq();
  return { ...req, args: [edit(callsOf(req))] };
};

/** An action's request with one of its ten arguments changed. */
const execWith = (p: Exec, i: number, value: unknown): WriteRequest => {
  const req = execReq(p);
  const args = [...req.args];
  args[i] = value;
  return { ...req, args };
};

/** The calldata the allowlist accepted; a refusal fails the test with its problem. */
const accepted = (req: WriteRequest, c: CallContext): Hex => {
  const out = allowedCall(req, c);
  if (!out.ok) throw new Error(`refused: ${out.problem}`);
  return out.data;
};

/** A calldata's length and hash, as the plan pins them. */
const pinned = (data: Hex, bytes: number, hash: Hex) => {
  expect(size(data)).toBe(bytes);
  expect(keccak256(data)).toBe(hash);
};

describe("the allowlist takes the pot's setup", () => {
  test("the setup of V5 is accepted, and its data is V5's bytes", () => {
    const req = potSetupCall(config, SETUP_V5, BigInt(650_000)) as WriteRequest;
    const a = allowedCall(req, { config, order: linked(), pot: SETUP_V5 });
    expect(a.ok && keccak256(a.data)).toBe(
      "0xb5141445053d556060d1ea2ca1cb75be1d85193cc326b949272fff21238a772d",
    );
    expect(req.value).toBe(BigInt("60100000000000000000"));
    pinned(
      accepted(req, potCtx(SETUP_V5)),
      1796,
      "0xb5141445053d556060d1ea2ca1cb75be1d85193cc326b949272fff21238a772d",
    );
  });

  test("the setup's request: aggregate3Value on the table's Multicall3 over the pinned ABI, create, fund the pot, fee money to the agent's key", () => {
    const req = setupReq();
    expect(req).toMatchObject({
      chainId: CHAIN,
      address: T.multicall3,
      functionName: "aggregate3Value",
      gas: SETUP_GAS,
    });
    expect(req.abi).toBe(multicall3Abi);
    expect(req.args).toHaveLength(1);
    const calls = callsOf(req);
    expect(calls.map((c) => c.target)).toEqual([T.proxyFactory, V3_POT, A]);
    expect(calls.map((c) => c.value)).toEqual([NO_WEI, SETUP_V5.fundWei, SETUP_V5.agentGasWei]);
    expect(calls.map((c) => c.allowFailure)).toEqual([false, false, false]);
  });

  test("V4: with no money the setup is one call, its value 0, and its data is V4's bytes; a value left out reads as 0", () => {
    const req = setupReq(SETUP_V4);
    expect(req.value).toBe(NO_WEI);
    expect(callsOf(req).map((c) => c.target)).toEqual([T.proxyFactory]);
    const data = accepted(req, potCtx(SETUP_V4));
    pinned(data, 1412, "0x50c45965c858bc26d42cfe3d36b6a90e33a0dca0a984b03af5e41112a9d23e73");
    expect(accepted({ ...req, value: undefined }, potCtx(SETUP_V4))).toBe(data);
  });

  test("V2, the real run's own setup, is refused: its period was five minutes, and the allowlist rebuilds thirty days", () => {
    const real = potSetupCalls(T, {
      guardian: G,
      agentWallet: A,
      token: T.usdc,
      ceilingUnits: BigInt(2_000_000),
      periodMinutes: 5,
      saltNonce: SALT,
      fundWei: BigInt("5000000000000000000"),
      agentGasWei: BigInt("100000000000000000"),
    });
    pinned(
      encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3Value", args: [real.calls] }),
      1796,
      "0x4b7b3d40ad68c749c0fd423f03c816f5a96bc6d48bdcdb48adcb292327340ad4",
    );
    const v2: Setup = {
      ...SETUP_V5,
      ceilingUnits: BigInt(2_000_000),
      saltNonce: SALT,
      fundWei: BigInt("5000000000000000000"),
    };
    const req: WriteRequest = { ...setupReq(v2), args: [real.calls], value: real.value };
    expect(real.value).toBe(BigInt("5100000000000000000"));
    expect(allowedCall(req, potCtx(v2))).toEqual(refused("setup_args"));
    // The same pot over thirty days is the allowlist's own rebuild.
    expect(allowedCall(setupReq(v2), potCtx(v2)).ok).toBe(true);
  });

  test("at its bounds: a ceiling of 1 and of 3,000,000,000 USDC, 1,000,000,000 USDC for the pot, 1 USDC of fee money, the largest salt nonce, gas 1,500,000", () => {
    const edges: Setup[] = [
      { ...SETUP_V5, ceilingUnits: USDC_UNIT },
      { ...SETUP_V5, ceilingUnits: BigInt(POT_CEILING_MAX_USDC) * USDC_UNIT },
      { ...SETUP_V5, fundWei: POT_FUND_MAX_UNITS * WEI_PER_UNIT },
      { ...SETUP_V5, agentGasWei: USDC_UNIT * WEI_PER_UNIT },
      { ...SETUP_V5, saltNonce: MAX_UINT256 },
      { ...SETUP_V5, fundWei: WEI_PER_UNIT, agentGasWei: NO_WEI },
    ];
    for (const p of edges) expect(allowedCall(setupReq(p), potCtx(p)).ok).toBe(true);
    expect(allowedCall(setupReq(SETUP_V5, BigInt(1_500_000)), potCtx(SETUP_V5)).ok).toBe(true);
  });

  test("addresses and call data in another letter case: the same data", () => {
    const req = setupWithCalls((calls) =>
      calls.map((c) => ({ ...c, target: lower(c.target), callData: upper(c.callData) as Hex })),
    );
    const shouted = { ...req, address: lower(T.multicall3) };
    const loud: Setup = { ...SETUP_V5, guardian: lower(G), agentWallet: upper(A) };
    const c = potCtx(loud, { order: linked({ guardian: upper(G), factory: lower(FACTORY) }) });
    expect(accepted(shouted, c)).toBe(accepted(setupReq(), potCtx(SETUP_V5)));
  });

  test("a setup with one wei more, or less, than the sum of its inner amounts is value_mismatch", () => {
    const req = setupReq();
    const sum = SETUP_V5.fundWei + SETUP_V5.agentGasWei;
    for (const value of [sum + BigInt(1), sum - BigInt(1), NO_WEI])
      expect(allowedCall({ ...req, value }, potCtx(SETUP_V5))).toEqual(refused("value_mismatch"));
    // Left out while the calls carry money, or the right amount as a number.
    expect(allowedCall({ ...req, value: undefined }, potCtx(SETUP_V5))).toEqual(refused("value_mismatch"));
    expect(allowedCall({ ...req, value: Number(sum) as unknown as bigint }, potCtx(SETUP_V5))).toEqual(
      refused("value_mismatch"),
    );
  });

  test("a setup whose second call names another address than the predicted pot is setup_args", () => {
    const elsewhere = setupWithCalls((calls) => {
      calls[1].target = ANOTHER_CONTRACT;
      return calls;
    });
    expect(allowedCall(elsewhere, potCtx(SETUP_V5))).toEqual(refused("setup_args"));
    // The pot predicted for another salt nonce is another address too.
    const otherPot = callsOf(setupReq({ ...SETUP_V5, saltNonce: BigInt(2) }))[1].target;
    expect(otherPot).not.toBe(V3_POT);
    const another = setupWithCalls((calls) => {
      calls[1].target = otherPot;
      return calls;
    });
    expect(allowedCall(another, potCtx(SETUP_V5))).toEqual(refused("setup_args"));
  });

  test("a setup whose third call pays another address than the agent's wallet is setup_args", () => {
    for (const to of [ANOTHER_CONTRACT, G, P, T.multicall3]) {
      const req = setupWithCalls((calls) => {
        calls[2].target = to;
        return calls;
      });
      expect(allowedCall(req, potCtx(SETUP_V5))).toEqual(refused("setup_args"));
    }
  });

  test("a setup with a fourth call is setup_args", () => {
    const transfer = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [ANOTHER_CONTRACT, BigInt(1)],
    });
    const req = setupWithCalls((calls) => [
      ...calls,
      { target: T.usdc, allowFailure: false, value: NO_WEI, callData: transfer },
    ]);
    expect(allowedCall(req, potCtx(SETUP_V5))).toEqual(refused("setup_args"));
  });

  test("the guardian of the context is not the order's: guardian_is_not_the_orders", () => {
    const another = { order: linked({ guardian: GUARDIAN }) };
    expect(allowedCall(setupReq(), potCtx(SETUP_V5, another))).toEqual(
      refused("guardian_is_not_the_orders"),
    );
    expect(allowedCall(execReq(STOP_V9), potCtx(STOP_V9, another))).toEqual(
      refused("guardian_is_not_the_orders"),
    );
    // A setup built for another account, for an order of the real guardian.
    const theirs: Setup = { ...SETUP_V5, guardian: GUARDIAN };
    expect(allowedCall(setupReq(theirs), potCtx(theirs))).toEqual(refused("guardian_is_not_the_orders"));
    // An order whose guardian could not be read.
    const unread = { order: linked({ guardian: "" as Address }) };
    expect(allowedCall(setupReq(), potCtx(SETUP_V5, unread))).toEqual(refused("guardian_is_not_the_orders"));
  });

  test("the agent's wallet is the guardian's, in another letter case: wallet_is_guardian; zero: wallet_is_zero", () => {
    for (const wallet of [lower(G), upper(G)]) {
      expect(allowedCall(setupReq(), potCtx({ ...SETUP_V5, agentWallet: wallet }))).toEqual(
        refused("wallet_is_guardian"),
      );
      expect(allowedCall(execReq(CHANGE_V6), potCtx({ ...CHANGE_V6, agentWallet: wallet }))).toEqual(
        refused("wallet_is_guardian"),
      );
      expect(potSetupCall(config, { ...SETUP_V5, agentWallet: wallet }, SETUP_GAS)).toEqual(
        refused("wallet_is_guardian"),
      );
    }
    expect(allowedCall(setupReq(), potCtx({ ...SETUP_V5, agentWallet: ZERO }))).toEqual(
      refused("wallet_is_zero"),
    );
    expect(allowedCall(execReq(CHANGE_V6), potCtx({ ...CHANGE_V6, agentWallet: ZERO }))).toEqual(
      refused("wallet_is_zero"),
    );
  });

  test("an order that is deployed, broken, or linked and revoked: order_not_linked", () => {
    const orders = [
      linked({ state: "deployed" }),
      linked({ state: "broken", brokenReason: "not_linked" }),
      linked({ state: "broken", brokenReason: "replaced" }),
      linked({ revoked: true }),
      linked({ state: "reserved" }),
      linked({ state: "superseded" }),
      linked({ state: "draft" }),
      // A revocation that was not served is not "not revoked".
      linked({ revoked: undefined as unknown as boolean }),
    ];
    for (const o of orders) {
      expect(allowedCall(setupReq(), potCtx(SETUP_V5, { order: o }))).toEqual(refused("order_not_linked"));
      expect(allowedCall(execReq(STOP_V9), potCtx(STOP_V9, { order: o }))).toEqual(
        refused("order_not_linked"),
      );
    }
  });

  test("chain 1 in the config: pot_chain_unsupported", () => {
    const chain1 = { ...config, chainId: 1 };
    const on1 = (pot: PotCallContext): CallContext => ({ config: chain1, order: linked({ chainId: 1 }), pot });
    expect(allowedCall({ ...setupReq(), chainId: 1 }, on1(SETUP_V5))).toEqual(refused("pot_chain_unsupported"));
    expect(allowedCall({ ...execReq(CHANGE_V6), chainId: 1 }, on1(CHANGE_V6))).toEqual(
      refused("pot_chain_unsupported"),
    );
    expect(potSetupCall(chain1, SETUP_V5, SETUP_GAS)).toEqual(refused("pot_chain_unsupported"));
    expect(potExecCall(chain1, CHANGE_V6, EXEC_GAS)).toEqual(refused("pot_chain_unsupported"));
  });

  test("a ceiling of 2.5 USDC in units, of 0, of 3,000,000,001 USDC: ceiling_out_of_bounds", () => {
    const ceilings = [BigInt(2_500_000), NO_WEI, BigInt(3_000_000_001) * USDC_UNIT, BigInt(1)];
    for (const ceilingUnits of ceilings) {
      expect(allowedCall(setupReq(), potCtx({ ...SETUP_V5, ceilingUnits }))).toEqual(
        refused("ceiling_out_of_bounds"),
      );
      expect(allowedCall(execReq(CHANGE_V6), potCtx({ ...CHANGE_V6, ceilingUnits }))).toEqual(
        refused("ceiling_out_of_bounds"),
      );
      expect(allowedCall(execReq(RESTORE_V11), potCtx({ ...RESTORE_V11, ceilingUnits }))).toEqual(
        refused("ceiling_out_of_bounds"),
      );
    }
  });

  test("fee money of 1.000001 USDC: agent_gas_out_of_bounds; a fund with a fraction of a unit: fund_out_of_bounds", () => {
    const fee = (agentGasWei: bigint) => allowedCall(setupReq(), potCtx({ ...SETUP_V5, agentGasWei }));
    const fund = (fundWei: bigint) => allowedCall(setupReq(), potCtx({ ...SETUP_V5, fundWei }));
    expect(fee(BigInt(1_000_001) * WEI_PER_UNIT)).toEqual(refused("agent_gas_out_of_bounds"));
    expect(fee(SETUP_V5.agentGasWei + BigInt(1))).toEqual(refused("agent_gas_out_of_bounds"));
    expect(fund(SETUP_V5.fundWei + BigInt(1))).toEqual(refused("fund_out_of_bounds"));
    expect(fund(SETUP_V5.fundWei - BigInt(1))).toEqual(refused("fund_out_of_bounds"));
    expect(fund((POT_FUND_MAX_UNITS + BigInt(1)) * WEI_PER_UNIT)).toEqual(refused("fund_out_of_bounds"));
  });

  test("no gas, gas 0, gas 1,500,001: gas_out_of_bounds", () => {
    const req = setupReq();
    for (const gas of [undefined, NO_WEI, BigInt(1_500_001), BigInt(-1), 650_000 as unknown as bigint])
      expect(allowedCall({ ...req, gas }, potCtx(SETUP_V5))).toEqual(refused("gas_out_of_bounds"));
    // An action of the guardian's takes 500,000 at most.
    expect(allowedCall(execReq(CHANGE_V6, BigInt(500_000)), potCtx(CHANGE_V6)).ok).toBe(true);
    expect(allowedCall(execReq(CHANGE_V6, BigInt(500_001)), potCtx(CHANGE_V6))).toEqual(
      refused("gas_out_of_bounds"),
    );
    expect(allowedCall({ ...execReq(CHANGE_V6), gas: undefined }, potCtx(CHANGE_V6))).toEqual(
      refused("gas_out_of_bounds"),
    );
  });
});

describe("the allowlist takes the guardian's Safe actions", () => {
  const vectors: [string, Exec, number, Hex][] = [
    ["V6 change", CHANGE_V6, 676, "0xc615b5f6bca36df97bbcb1f78c3a6a5f5a4cfb3c0f932d529192511423f01944"],
    ["V9 stop", STOP_V9, 900, "0xd709c6dfd342e50a6df9859f5063de95552f967b76c3281224a69a8c93507324"],
    ["V10 take back", WITHDRAW_V10, 484, "0xce7031830a444423e2440b3aa34c5e9bfd41e6606641d3deb24abb35961dd164"],
    ["V11 start again", RESTORE_V11, 1092, "0x86747b4dd8d72f104246417a357650d86a7dd380fef6a438545ae98b453fdb76"],
    ["V12 new key", RESTORE_V12, 1124, "0xf8652af05b7d90febd332989e7aa09032325dac7467a629f72dc61fb28bed50c"],
    ["V13 new key on a stopped pot", RESTORE_V13, 1092, "0x80154523980e27f1c18cdd015aedbfb47a427bc92292b88995879b2373401c12"],
  ];

  test("V6 change, V9 stop, V10 take back, V11 start again and V12 new key are accepted on the pot, each with its vector's data", () => {
    for (const [name, p, bytes, hash] of vectors) {
      const req = execReq(p);
      expect(req, name).toMatchObject({
        chainId: CHAIN,
        address: REAL_SAFE,
        functionName: "execTransaction",
        gas: EXEC_GAS,
      });
      expect(req.abi).toBe(safeAbi);
      expect("value" in req).toBe(false);
      pinned(accepted(req, potCtx(p)), bytes, hash);
    }
  });

  test("a value of 0 is no value", () => {
    expect(accepted({ ...execReq(CHANGE_V6), value: NO_WEI }, potCtx(CHANGE_V6))).toBe(
      accepted(execReq(CHANGE_V6), potCtx(CHANGE_V6)),
    );
  });

  test("the pot, the guardian, the addresses and the bytes in another letter case: the same data", () => {
    for (const [, p] of vectors) {
      const req = execReq(p);
      const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refund, sig] = req.args;
      const shouted: WriteRequest = {
        ...req,
        address: lower(REAL_SAFE),
        args: [
          lower(to as string),
          value,
          upper(data as string),
          operation,
          safeTxGas,
          baseGas,
          gasPrice,
          upper(gasToken as string),
          lower(refund as string),
          upper(sig as string),
        ],
      };
      const loud = { ...p, pot: upper(REAL_SAFE), guardian: lower(G) } as Exec;
      expect(accepted(shouted, potCtx(loud))).toBe(accepted(req, potCtx(p)));
    }
  });

  test("a restore to the guardian's own wallet: wallet_is_guardian; with another module listed: restore_other_module", () => {
    const req = execReq(RESTORE_V11);
    expect(allowedCall(req, potCtx({ ...RESTORE_V11, agentWallet: upper(G) }))).toEqual(
      refused("wallet_is_guardian"),
    );
    expect(allowedCall(req, potCtx({ ...RESTORE_V11, agentWallet: ZERO }))).toEqual(refused("wallet_is_zero"));
    for (const modules of [[OTHER_MODULE], [T.allowanceModule, OTHER_MODULE], [OTHER_MODULE, T.allowanceModule]])
      expect(allowedCall(req, potCtx({ ...RESTORE_V11, modules }))).toEqual(refused("restore_other_module"));
    expect(potExecCall(config, { ...RESTORE_V11, modules: [OTHER_MODULE] }, EXEC_GAS)).toEqual(
      refused("restore_other_module"),
    );
  });

  test("an execTransaction on another address than the pot: not_the_pot; with a value: sends_value", () => {
    for (const address of [ANOTHER_CONTRACT, T.multicall3, T.allowanceModule, G])
      expect(allowedCall({ ...execReq(CHANGE_V6), address }, potCtx(CHANGE_V6))).toEqual(refused("not_the_pot"));
    // The request on the real Safe, while the pot noted for the order is another one.
    expect(allowedCall(execReq(CHANGE_V6), potCtx({ ...CHANGE_V6, pot: V3_POT }))).toEqual(
      refused("not_the_pot"),
    );
    for (const p of [CHANGE_V6, WITHDRAW_V10])
      expect(allowedCall({ ...execReq(p), value: BigInt(1) }, potCtx(p))).toEqual(refused("sends_value"));
    expect(
      allowedCall({ ...execReq(CHANGE_V6), value: 0 as unknown as bigint }, potCtx(CHANGE_V6)),
    ).toEqual(refused("sends_value"));
  });

  test("take back while a module is on: allowance_still_on; with nothing in the pot: nothing_to_withdraw", () => {
    const req = execReq(WITHDRAW_V10);
    for (const modules of [[T.allowanceModule], [OTHER_MODULE]]) {
      expect(allowedCall(req, potCtx({ ...WITHDRAW_V10, modules }))).toEqual(refused("allowance_still_on"));
      // Before the balance is read.
      expect(allowedCall(req, potCtx({ ...WITHDRAW_V10, modules, balanceWei: NO_WEI }))).toEqual(
        refused("allowance_still_on"),
      );
    }
    expect(allowedCall(req, potCtx({ ...WITHDRAW_V10, balanceWei: NO_WEI }))).toEqual(
      refused("nothing_to_withdraw"),
    );
    expect(potExecCall(config, { ...WITHDRAW_V10, balanceWei: NO_WEI }, EXEC_GAS)).toEqual(
      refused("nothing_to_withdraw"),
    );
  });

  test("a stop with no delegate and no module: nothing_to_stop", () => {
    const req = execReq(STOP_V9);
    expect(allowedCall(req, potCtx({ ...STOP_V9, delegates: [], modules: [] }))).toEqual(
      refused("nothing_to_stop"),
    );
    // Another module alone is not the pot's add-on: nothing of the pot's to stop either.
    expect(allowedCall(req, potCtx({ ...STOP_V9, delegates: [], modules: [OTHER_MODULE] }))).toEqual(
      refused("nothing_to_stop"),
    );
    expect(potExecCall(config, { ...STOP_V9, delegates: [], modules: [] }, EXEC_GAS)).toEqual(
      refused("nothing_to_stop"),
    );
  });

  test("an action built from another reading than the click's: exec_args", () => {
    // The restore built for the key the card showed, while the registry names a new one.
    expect(allowedCall(execReq(RESTORE_V11), potCtx(RESTORE_V13))).toEqual(refused("exec_args"));
    // A change to another ceiling than the context's.
    expect(allowedCall(execReq({ ...CHANGE_V6, ceilingUnits: BigInt(50_000_000) }), potCtx(CHANGE_V6))).toEqual(
      refused("exec_args"),
    );
    // A stop built when the add-on was off, while it is on.
    expect(allowedCall(execReq({ ...STOP_V9, modules: [] }), potCtx(STOP_V9))).toEqual(refused("exec_args"));
    // A take back of more than the pot holds now.
    expect(
      allowedCall(execReq(WITHDRAW_V10), potCtx({ ...WITHDRAW_V10, balanceWei: BigInt("2000000000000000000") })),
    ).toEqual(refused("exec_args"));
    // Each kind's arguments under another kind's context.
    expect(allowedCall(execReq(STOP_V9), potCtx(CHANGE_V6))).toEqual(refused("exec_args"));
    expect(allowedCall(execReq(WITHDRAW_V10), potCtx(RESTORE_V11))).toEqual(refused("exec_args"));
  });
});

describe("the allowlist refuses a pot call", () => {
  const setup = setupReq();
  const change = execReq(CHANGE_V6);
  const stop = execReq(STOP_V9);
  const withdraw = execReq(WITHDRAW_V10);
  const restore = execReq(RESTORE_V11);
  const calls = callsOf(setup);
  const on1: CallContext = { config: { ...config, chainId: 1 }, order: linked({ chainId: 1 }) };
  const eleven = Array.from({ length: 11 }, () => A);
  const cases: [string, WriteRequest, CallContext, string][] = [
    ["a setup on another chain", { ...setup, chainId: OTHER_CHAIN }, potCtx(SETUP_V5), "wrong_chain"],
    ["an action on another chain", { ...change, chainId: OTHER_CHAIN }, potCtx(CHANGE_V6), "wrong_chain"],
    ["a setup on a chain the table does not know", { ...setup, chainId: 1 }, { ...on1, pot: SETUP_V5 }, "pot_chain_unsupported"],
    ["an action on a chain the table does not know", { ...change, chainId: 1 }, { ...on1, pot: CHANGE_V6 }, "pot_chain_unsupported"],
    ["a setup with no pot context", setup, { config, order: linked() }, "no_pot_context"],
    ["an action with no pot context", change, { config, order: linked() }, "no_pot_context"],
    ["a pot context that is null", setup, potCtx(odd(null as unknown as Record<string, unknown>)), "no_pot_context"],
    ["a pot context that is a string", change, potCtx(odd("change" as unknown as Record<string, unknown>)), "no_pot_context"],
    ["a setup over an action's context", setup, potCtx(CHANGE_V6), "no_pot_context"],
    ["an action over the setup's context", change, potCtx(SETUP_V5), "no_pot_context"],
    ["an action of a kind the allowlist does not know", change, potCtx(odd({ ...CHANGE_V6, kind: "add_money" })), "no_pot_context"],
    ["a guardian that is not an address", setup, potCtx(odd({ ...SETUP_V5, guardian: "0x1234" })), "no_pot_context"],
    ["no guardian", stop, potCtx(odd({ ...STOP_V9, guardian: undefined })), "no_pot_context"],
    ["a guardian as a number", change, potCtx(odd({ ...CHANGE_V6, guardian: 1 })), "no_pot_context"],
    ["an agent's wallet that is not an address", setup, potCtx(odd({ ...SETUP_V5, agentWallet: `${A}0` })), "no_pot_context"],
    ["no agent's wallet for a restore", restore, potCtx(odd({ ...RESTORE_V11, agentWallet: undefined })), "no_pot_context"],
    ["a pot that is not an address", change, potCtx(odd({ ...CHANGE_V6, pot: "0xb0d1e" })), "no_pot_context"],
    ["no pot for a take back", withdraw, potCtx(odd({ ...WITHDRAW_V10, pot: undefined })), "no_pot_context"],
    ["a ceiling as a number", setup, potCtx(odd({ ...SETUP_V5, ceilingUnits: 50_000_000 })), "no_pot_context"],
    ["a ceiling below 0", change, potCtx(odd({ ...CHANGE_V6, ceilingUnits: BigInt(-1) })), "no_pot_context"],
    ["a salt nonce as a string", setup, potCtx(odd({ ...SETUP_V5, saltNonce: "1" })), "no_pot_context"],
    ["money for the pot below 0", setup, potCtx(odd({ ...SETUP_V5, fundWei: BigInt(-1) })), "no_pot_context"],
    ["no fee money field", setup, potCtx(odd({ ...SETUP_V5, agentGasWei: undefined })), "no_pot_context"],
    ["a balance below 0", withdraw, potCtx(odd({ ...WITHDRAW_V10, balanceWei: BigInt(-1) })), "no_pot_context"],
    ["a balance past any uint256", withdraw, potCtx(odd({ ...WITHDRAW_V10, balanceWei: MAX_UINT256 + BigInt(1) })), "no_pot_context"],
    ["delegates that are not a list", stop, potCtx(odd({ ...STOP_V9, delegates: A })), "no_pot_context"],
    ["modules that are not a list", withdraw, potCtx(odd({ ...WITHDRAW_V10, modules: null })), "no_pot_context"],
    ["no modules for a restore", restore, potCtx(odd({ ...RESTORE_V11, modules: undefined })), "no_pot_context"],
    ["a setup with no order", setup, potCtx(SETUP_V5, { order: null }), "no_order"],
    ["an action with no order", stop, potCtx(STOP_V9, { order: null }), "no_order"],
    ["an order that is undefined", change, potCtx(CHANGE_V6, { order: undefined as unknown as null }), "no_order"],
    ["an order on another chain", setup, potCtx(SETUP_V5, { order: linked({ chainId: OTHER_CHAIN }) }), "order_on_another_deployment"],
    ["an order of another factory", change, potCtx(CHANGE_V6, { order: linked({ factory: ANOTHER_FACTORY }) }), "order_on_another_deployment"],
    ["a body not linked yet", setup, potCtx(SETUP_V5, { order: linked({ state: "deployed" }) }), "order_not_linked"],
    ["a revoked body", withdraw, potCtx(WITHDRAW_V10, { order: linked({ revoked: true }) }), "order_not_linked"],
    ["another guardian", restore, potCtx(RESTORE_V11, { order: linked({ guardian: GUARDIAN }) }), "guardian_is_not_the_orders"],
    ["a setup with no gas", { ...setup, gas: undefined }, potCtx(SETUP_V5), "gas_out_of_bounds"],
    ["a setup with gas 1,500,001", { ...setup, gas: BigInt(1_500_001) }, potCtx(SETUP_V5), "gas_out_of_bounds"],
    ["an action with gas 500,001", { ...stop, gas: BigInt(500_001) }, potCtx(STOP_V9), "gas_out_of_bounds"],
    ["an action with gas 0", { ...withdraw, gas: NO_WEI }, potCtx(WITHDRAW_V10), "gas_out_of_bounds"],
    ["a setup to another contract", { ...setup, address: ANOTHER_CONTRACT }, potCtx(SETUP_V5), "not_multicall3"],
    ["a setup to the registry", { ...setup, address: REGISTRY }, potCtx(SETUP_V5), "not_multicall3"],
    ["a setup to the Safe factory", { ...setup, address: T.proxyFactory }, potCtx(SETUP_V5), "not_multicall3"],
    [
      "a setup over an ABI equal to the pinned one but not it",
      { ...setup, abi: [...multicall3Abi] as unknown as typeof multicall3Abi },
      potCtx(SETUP_V5),
      "not_the_pinned_abi",
    ],
    ["a setup over the Safe's ABI", { ...setup, abi: safeAbi }, potCtx(SETUP_V5), "not_the_pinned_abi"],
    ["a setup over the registry's ABI", { ...setup, abi: identityRegistryAbi }, potCtx(SETUP_V5), "not_the_pinned_abi"],
    ["a setup for the zero address", setup, potCtx({ ...SETUP_V5, agentWallet: ZERO }), "wallet_is_zero"],
    ["a setup for the guardian's own wallet", setup, potCtx({ ...SETUP_V5, agentWallet: lower(G) }), "wallet_is_guardian"],
    ["a setup with a ceiling of 0", setup, potCtx({ ...SETUP_V5, ceilingUnits: NO_WEI }), "ceiling_out_of_bounds"],
    ["a setup with a ceiling of 2.5 USDC", setup, potCtx({ ...SETUP_V5, ceilingUnits: BigInt(2_500_000) }), "ceiling_out_of_bounds"],
    ["money for the pot with a fraction of a unit", setup, potCtx({ ...SETUP_V5, fundWei: BigInt(1) }), "fund_out_of_bounds"],
    [
      "money for the pot above 1,000,000,000 USDC",
      setup,
      potCtx({ ...SETUP_V5, fundWei: (POT_FUND_MAX_UNITS + BigInt(1)) * WEI_PER_UNIT }),
      "fund_out_of_bounds",
    ],
    ["fee money with a fraction of a unit", setup, potCtx({ ...SETUP_V5, agentGasWei: BigInt(1) }), "agent_gas_out_of_bounds"],
    [
      "fee money above 1 USDC",
      setup,
      potCtx({ ...SETUP_V5, agentGasWei: (USDC_UNIT + BigInt(1)) * WEI_PER_UNIT }),
      "agent_gas_out_of_bounds",
    ],
    ["a salt nonce past any uint256", setup, potCtx({ ...SETUP_V5, saltNonce: MAX_UINT256 + BigInt(1) }), "salt_out_of_bounds"],
    ["a value one wei above the sum", { ...setup, value: (setup.value as bigint) + BigInt(1) }, potCtx(SETUP_V5), "value_mismatch"],
    ["a value as a string", { ...setup, value: "60100000000000000000" as unknown as bigint }, potCtx(SETUP_V5), "value_mismatch"],
    ["a second call to another address", setupWithCalls((c) => [c[0], { ...c[1], target: ANOTHER_CONTRACT }, c[2]]), potCtx(SETUP_V5), "setup_args"],
    ["a call that may fail", setupWithCalls((c) => [c[0], { ...c[1], allowFailure: true as unknown as false }, c[2]]), potCtx(SETUP_V5), "setup_args"],
    [
      "one wei moved from the pot's money to the fee money, the sum unchanged",
      setupWithCalls((c) => [c[0], { ...c[1], value: c[1].value - BigInt(1) }, { ...c[2], value: c[2].value + BigInt(1) }]),
      potCtx(SETUP_V5),
      "setup_args",
    ],
    ["the pot's money as a number", setupWithCalls((c) => [c[0], { ...c[1], value: 60e18 as unknown as bigint }, c[2]]), potCtx(SETUP_V5), "setup_args"],
    ["the creation's call data changed", setupWithCalls((c) => [{ ...c[0], callData: `${c[0].callData}00` as Hex }, c[1], c[2]]), potCtx(SETUP_V5), "setup_args"],
    ["a payment with call data", setupWithCalls((c) => [c[0], c[1], { ...c[2], callData: "0x00" }]), potCtx(SETUP_V5), "setup_args"],
    ["the calls in another order", setupWithCalls((c) => [c[0], c[2], c[1]]), potCtx(SETUP_V5), "setup_args"],
    ["the calls for another agent's wallet", setupReq({ ...SETUP_V5, agentWallet: P }), potCtx(SETUP_V5), "setup_args"],
    ["the calls for another salt nonce", setupReq({ ...SETUP_V5, saltNonce: BigInt(2) }), potCtx(SETUP_V5), "setup_args"],
    ["the calls for another ceiling", setupReq({ ...SETUP_V5, ceilingUnits: BigInt(60_000_000) }), potCtx(SETUP_V5), "setup_args"],
    ["the calls for another guardian", { ...setupReq({ ...SETUP_V5, guardian: P }) }, potCtx(SETUP_V5), "setup_args"],
    ["no calls", { ...setup, args: [[]] }, potCtx(SETUP_V5), "setup_args"],
    ["two lists of calls", { ...setup, args: [calls, calls] }, potCtx(SETUP_V5), "setup_args"],
    ["the calls not in a list", { ...setup, args: [calls[0]] }, potCtx(SETUP_V5), "setup_args"],
    ["a call that is not an object", { ...setup, args: [[calls[0], null, calls[2]]] }, potCtx(SETUP_V5), "setup_args"],
    ["setup arguments that are not a list", { ...setup, args: undefined as unknown as unknown[] }, potCtx(SETUP_V5), "setup_args"],
    ["an action that sends value", { ...change, value: BigInt(1) }, potCtx(CHANGE_V6), "sends_value"],
    ["a take back that sends value", { ...withdraw, value: BigInt(1) }, potCtx(WITHDRAW_V10), "sends_value"],
    [
      "an action over an ABI equal to the pinned one but not it",
      { ...change, abi: [...safeAbi] as unknown as typeof safeAbi },
      potCtx(CHANGE_V6),
      "not_the_pinned_abi",
    ],
    ["an action over Multicall3's ABI", { ...stop, abi: multicall3Abi }, potCtx(STOP_V9), "not_the_pinned_abi"],
    ["an action on another address", { ...change, address: ANOTHER_CONTRACT }, potCtx(CHANGE_V6), "not_the_pot"],
    ["an action on another pot than the noted one", change, potCtx({ ...CHANGE_V6, pot: V3_POT }), "not_the_pot"],
    ["a change for the zero address", change, potCtx({ ...CHANGE_V6, agentWallet: ZERO }), "wallet_is_zero"],
    ["a change for the guardian's wallet", change, potCtx({ ...CHANGE_V6, agentWallet: G }), "wallet_is_guardian"],
    ["a change to a ceiling of 0", change, potCtx({ ...CHANGE_V6, ceilingUnits: NO_WEI }), "ceiling_out_of_bounds"],
    ["a stop with eleven delegates", stop, potCtx({ ...STOP_V9, delegates: eleven }), "no_pot_context"],
    ["a stop with eleven modules", stop, potCtx({ ...STOP_V9, modules: eleven }), "no_pot_context"],
    ["a stop with a delegate that is not an address", stop, potCtx(odd({ ...STOP_V9, delegates: ["0x1234"] })), "no_pot_context"],
    ["a stop with a module that is not a string", stop, potCtx(odd({ ...STOP_V9, modules: [BigInt(1)] })), "no_pot_context"],
    ["a stop with nothing to stop", stop, potCtx({ ...STOP_V9, delegates: [], modules: [] }), "nothing_to_stop"],
    ["a take back while the add-on is on", withdraw, potCtx({ ...WITHDRAW_V10, modules: [T.allowanceModule] }), "allowance_still_on"],
    ["a take back from an empty pot", withdraw, potCtx({ ...WITHDRAW_V10, balanceWei: NO_WEI }), "nothing_to_withdraw"],
    ["a restore for the zero address", restore, potCtx({ ...RESTORE_V11, agentWallet: ZERO }), "wallet_is_zero"],
    ["a restore for the guardian's wallet", restore, potCtx({ ...RESTORE_V11, agentWallet: G }), "wallet_is_guardian"],
    ["a restore to a ceiling of 3,000,000,001 USDC", restore, potCtx({ ...RESTORE_V11, ceilingUnits: BigInt(3_000_000_001) * USDC_UNIT }), "ceiling_out_of_bounds"],
    ["a restore with eleven delegates", restore, potCtx({ ...RESTORE_V11, delegates: eleven }), "no_pot_context"],
    ["a restore with a module that is not an address", restore, potCtx(odd({ ...RESTORE_V11, modules: ["module"] })), "no_pot_context"],
    ["a restore with another module", restore, potCtx({ ...RESTORE_V11, modules: [OTHER_MODULE] }), "restore_other_module"],
    ["a change sent as a delegatecall", execWith(CHANGE_V6, 3, 1), potCtx(CHANGE_V6), "exec_args"],
    ["a change to another contract", execWith(CHANGE_V6, 0, ANOTHER_CONTRACT), potCtx(CHANGE_V6), "exec_args"],
    ["a change that moves value from the pot", execWith(CHANGE_V6, 1, BigInt(1)), potCtx(CHANGE_V6), "exec_args"],
    ["a change with other data", execWith(CHANGE_V6, 2, "0x"), potCtx(CHANGE_V6), "exec_args"],
    ["a Safe gas", execWith(CHANGE_V6, 4, BigInt(1)), potCtx(CHANGE_V6), "exec_args"],
    ["a base gas", execWith(STOP_V9, 5, BigInt(1)), potCtx(STOP_V9), "exec_args"],
    ["a gas price the pot would refund", execWith(STOP_V9, 6, BigInt(1)), potCtx(STOP_V9), "exec_args"],
    ["a gas token", execWith(WITHDRAW_V10, 7, T.usdc), potCtx(WITHDRAW_V10), "exec_args"],
    ["a refund receiver", execWith(WITHDRAW_V10, 8, ANOTHER_CONTRACT), potCtx(WITHDRAW_V10), "exec_args"],
    ["another owner's approval", execWith(RESTORE_V11, 9, ownerApprovalSignature(GUARDIAN)), potCtx(RESTORE_V11), "exec_args"],
    ["a take back to another address", execWith(WITHDRAW_V10, 0, ANOTHER_CONTRACT), potCtx(WITHDRAW_V10), "exec_args"],
    ["the operation as a bigint", execWith(CHANGE_V6, 3, BigInt(0)), potCtx(CHANGE_V6), "exec_args"],
    ["the value as a number", execWith(WITHDRAW_V10, 1, 3e18), potCtx(WITHDRAW_V10), "exec_args"],
    ["nine arguments", { ...change, args: change.args.slice(0, 9) }, potCtx(CHANGE_V6), "exec_args"],
    ["eleven arguments", { ...change, args: [...change.args, "0x"] }, potCtx(CHANGE_V6), "exec_args"],
    ["action arguments that are not a list", { ...change, args: null as unknown as unknown[] }, potCtx(CHANGE_V6), "exec_args"],
  ];

  test.each(cases)("%s", (_name, req, c, problem) => {
    expect(allowedCall(req, c)).toEqual(refused(problem));
  });

  test("covers every problem the pot's calls can name", () => {
    expect(new Set(cases.map((c) => c[3]))).toEqual(
      new Set([
        "wrong_chain",
        "pot_chain_unsupported",
        "no_pot_context",
        "no_order",
        "order_on_another_deployment",
        "order_not_linked",
        "guardian_is_not_the_orders",
        "gas_out_of_bounds",
        "not_multicall3",
        "not_the_pinned_abi",
        "wallet_is_zero",
        "wallet_is_guardian",
        "ceiling_out_of_bounds",
        "fund_out_of_bounds",
        "agent_gas_out_of_bounds",
        "salt_out_of_bounds",
        "value_mismatch",
        "setup_args",
        "sends_value",
        "not_the_pot",
        "nothing_to_stop",
        "allowance_still_on",
        "nothing_to_withdraw",
        "restore_other_module",
        "exec_args",
      ]),
    );
  });

  test("the setup: the first rule broken names the problem, in the order the rules are written", () => {
    const bad: Setup = {
      ...SETUP_V5,
      agentWallet: ZERO,
      ceilingUnits: NO_WEI,
      fundWei: BigInt(1),
      agentGasWei: BigInt(1),
      saltNonce: MAX_UINT256 + BigInt(1),
    };
    const everything: WriteRequest = {
      ...setup,
      chainId: CHAIN,
      address: ANOTHER_CONTRACT,
      abi: [...multicall3Abi] as unknown as typeof multicall3Abi,
      gas: undefined,
      value: BigInt(1),
      args: [[...calls, calls[2]]],
    };
    const chain1 = { ...config, chainId: 1 };
    const stranger = linked({ factory: ANOTHER_FACTORY, state: "deployed", guardian: GUARDIAN });
    const steps: [WriteRequest, CallContext, string][] = [
      [everything, { config: chain1, order: stranger }, "wrong_chain"],
      [{ ...everything, chainId: 1 }, { config: chain1, order: stranger, pot: bad }, "pot_chain_unsupported"],
      [everything, { config, order: stranger }, "no_pot_context"],
      [everything, { config, order: stranger, pot: odd({ ...bad, kind: "change" }) }, "no_pot_context"],
      [everything, { config, order: null, pot: bad }, "no_order"],
      [everything, { config, order: stranger, pot: bad }, "order_on_another_deployment"],
      [everything, { config, order: linked({ state: "deployed", guardian: GUARDIAN }), pot: bad }, "order_not_linked"],
      [everything, { config, order: linked({ guardian: GUARDIAN }), pot: bad }, "guardian_is_not_the_orders"],
      [everything, potCtx(bad), "gas_out_of_bounds"],
      [{ ...everything, gas: SETUP_GAS }, potCtx(bad), "not_multicall3"],
      [{ ...everything, gas: SETUP_GAS, address: T.multicall3 }, potCtx(bad), "not_the_pinned_abi"],
      [{ ...everything, gas: SETUP_GAS, address: T.multicall3, abi: multicall3Abi }, potCtx(bad), "wallet_is_zero"],
    ];
    const sound = { ...everything, gas: SETUP_GAS, address: T.multicall3, abi: multicall3Abi };
    const later: [Setup, string][] = [
      [{ ...bad, agentWallet: G }, "wallet_is_guardian"],
      [{ ...bad, agentWallet: A }, "ceiling_out_of_bounds"],
      [{ ...bad, agentWallet: A, ceilingUnits: SETUP_V5.ceilingUnits }, "fund_out_of_bounds"],
      [{ ...bad, agentWallet: A, ceilingUnits: SETUP_V5.ceilingUnits, fundWei: SETUP_V5.fundWei }, "agent_gas_out_of_bounds"],
      [{ ...SETUP_V5, saltNonce: bad.saltNonce }, "salt_out_of_bounds"],
      [SETUP_V5, "value_mismatch"],
    ];
    for (const [p, problem] of later) steps.push([sound, potCtx(p), problem]);
    steps.push([{ ...sound, value: setup.value }, potCtx(SETUP_V5), "setup_args"]);
    for (const [req, c, problem] of steps) expect(allowedCall(req, c)).toEqual(refused(problem));
    expect(allowedCall({ ...sound, value: setup.value, args: [calls] }, potCtx(SETUP_V5)).ok).toBe(true);
  });

  test("an action: the common rules, then its own, then its kind's, in the order they are written", () => {
    const bad: Change = { ...CHANGE_V6, agentWallet: ZERO, ceilingUnits: NO_WEI };
    const everything: WriteRequest = {
      ...change,
      address: ANOTHER_CONTRACT,
      abi: [...safeAbi] as unknown as typeof safeAbi,
      gas: BigInt(500_001),
      value: BigInt(1),
      args: [],
    };
    const chain1 = { ...config, chainId: 1 };
    const stranger = linked({ chainId: OTHER_CHAIN, state: "broken", guardian: GUARDIAN });
    const steps: [WriteRequest, CallContext, string][] = [
      [{ ...everything, chainId: OTHER_CHAIN }, { config, order: stranger, pot: bad }, "wrong_chain"],
      [{ ...everything, chainId: 1 }, { config: chain1, order: stranger, pot: bad }, "pot_chain_unsupported"],
      [everything, { config, order: stranger, pot: odd({ ...bad, guardian: undefined }) }, "no_pot_context"],
      [everything, { config, order: null, pot: bad }, "no_order"],
      [everything, { config, order: stranger, pot: bad }, "order_on_another_deployment"],
      [everything, { config, order: linked({ state: "broken", guardian: GUARDIAN }), pot: bad }, "order_not_linked"],
      [everything, { config, order: linked({ guardian: GUARDIAN }), pot: bad }, "guardian_is_not_the_orders"],
      [everything, potCtx(bad), "gas_out_of_bounds"],
      [{ ...everything, gas: EXEC_GAS }, potCtx(bad), "sends_value"],
      [{ ...everything, gas: EXEC_GAS, value: undefined }, potCtx(bad), "not_the_pinned_abi"],
      [{ ...everything, gas: EXEC_GAS, value: undefined, abi: safeAbi }, potCtx(bad), "not_the_pot"],
    ];
    const sound = { ...everything, gas: EXEC_GAS, value: undefined, abi: safeAbi, address: REAL_SAFE };
    const kinds: [Exec, string][] = [
      [bad, "wallet_is_zero"],
      [{ ...bad, agentWallet: G }, "wallet_is_guardian"],
      [{ ...bad, agentWallet: A }, "ceiling_out_of_bounds"],
      [CHANGE_V6, "exec_args"],
      [{ ...STOP_V9, delegates: Array.from({ length: 11 }, () => A), modules: [] }, "no_pot_context"],
      [{ ...STOP_V9, delegates: [], modules: [] }, "nothing_to_stop"],
      [STOP_V9, "exec_args"],
      [{ ...WITHDRAW_V10, modules: [T.allowanceModule], balanceWei: NO_WEI }, "allowance_still_on"],
      [{ ...WITHDRAW_V10, balanceWei: NO_WEI }, "nothing_to_withdraw"],
      [WITHDRAW_V10, "exec_args"],
      [{ ...RESTORE_V11, agentWallet: G, ceilingUnits: NO_WEI, delegates: Array.from({ length: 11 }, () => A), modules: [OTHER_MODULE] }, "wallet_is_guardian"],
      [{ ...RESTORE_V11, ceilingUnits: NO_WEI, delegates: Array.from({ length: 11 }, () => A), modules: [OTHER_MODULE] }, "ceiling_out_of_bounds"],
      [{ ...RESTORE_V11, delegates: Array.from({ length: 11 }, () => A), modules: [OTHER_MODULE] }, "no_pot_context"],
      [{ ...RESTORE_V11, modules: [OTHER_MODULE] }, "restore_other_module"],
      [RESTORE_V11, "exec_args"],
    ];
    for (const [p, problem] of kinds) steps.push([sound, potCtx(p), problem]);
    for (const [req, c, problem] of steps) expect(allowedCall(req, c)).toEqual(refused(problem));
    for (const p of [CHANGE_V6, STOP_V9, WITHDRAW_V10, RESTORE_V11])
      expect(allowedCall({ ...sound, args: execReq(p).args }, potCtx(p)).ok).toBe(true);
  });

  test("never throws on what it is handed: every case above refuses, and so does a request with nothing in it", () => {
    for (const [, req, c] of cases) expect(() => allowedCall(req, c)).not.toThrow();
    const empties: unknown[][] = [[], [[]], [[{}]], [undefined], [[undefined, undefined, undefined]]];
    for (const args of empties) {
      expect(allowedCall({ ...setup, args }, potCtx(SETUP_V5)).ok).toBe(false);
      expect(allowedCall({ ...change, args }, potCtx(CHANGE_V6)).ok).toBe(false);
    }
    const strange = [42, "0x", [], { kind: "setup" }, { kind: "stop" }, { kind: "withdraw", modules: [] }];
    for (const pot of strange) {
      expect(allowedCall(setup, potCtx(odd(pot as Record<string, unknown>)))).toEqual(refused("no_pot_context"));
      expect(allowedCall(change, potCtx(odd(pot as Record<string, unknown>)))).toEqual(refused("no_pot_context"));
    }
  });

  test("the builders refuse what they cannot build, and never throw", () => {
    expect(potSetupCall(config, odd({ ...SETUP_V5, guardian: "0x1" }) as Setup, SETUP_GAS)).toEqual(refused("no_pot_context"));
    expect(potSetupCall(config, { ...SETUP_V5, ceilingUnits: NO_WEI }, SETUP_GAS)).toEqual(refused("ceiling_out_of_bounds"));
    expect(potSetupCall(config, { ...SETUP_V5, fundWei: BigInt(-1) }, SETUP_GAS)).toEqual(refused("no_pot_context"));
    expect(potSetupCall(config, { ...SETUP_V5, saltNonce: MAX_UINT256 + BigInt(1) }, SETUP_GAS)).toEqual(
      refused("salt_out_of_bounds"),
    );
    expect(potExecCall(config, odd({ ...STOP_V9, delegates: "all" }) as Stop, EXEC_GAS)).toEqual(refused("no_pot_context"));
    expect(potExecCall(config, { ...WITHDRAW_V10, modules: [T.allowanceModule] }, EXEC_GAS)).toEqual(
      refused("allowance_still_on"),
    );
    expect(potExecCall(config, { ...CHANGE_V6, ceilingUnits: BigInt(1) }, EXEC_GAS)).toEqual(
      refused("ceiling_out_of_bounds"),
    );
    expect(potExecCall(config, odd({ ...SETUP_V5 }) as Change, EXEC_GAS)).toEqual(refused("no_pot_context"));
    expect(potSetupCall(config, odd({ ...CHANGE_V6 }) as Setup, SETUP_GAS)).toEqual(refused("no_pot_context"));
  });

  test("a function outside the six takes the registry's path, and is refused", () => {
    const names = ["aggregate3", "aggregate", "multicall", "execTransactionFromModule", "enableModule", "setup", "transfer"];
    for (const functionName of names) {
      const fn = functionName as unknown as WriteRequest["functionName"];
      // The registry's rules, in their order: a value first, then the registry's address.
      expect(allowedCall({ ...setup, functionName: fn }, potCtx(SETUP_V5))).toEqual(refused("sends_value"));
      expect(allowedCall({ ...setup, value: undefined, functionName: fn }, potCtx(SETUP_V5))).toEqual(
        refused("not_the_registry"),
      );
      expect(allowedCall({ ...change, functionName: fn }, potCtx(CHANGE_V6))).toEqual(refused("not_the_registry"));
      // On the registry itself, over the registry's ABI: not one of its four calls.
      expect(
        allowedCall({ ...registerCall(config, null), functionName: fn }, potCtx(SETUP_V5)),
      ).toEqual(refused("not_allowed"));
    }
    // A registry call over a pot's ABI is the registry's refusal.
    expect(allowedCall({ ...registerCall(config, null), abi: multicall3Abi }, ctx)).toEqual(
      refused("not_the_pinned_abi"),
    );
    // A setup carrying money still takes the pot's path, never the registry's value rule.
    expect(allowedCall({ ...setup, functionName: "aggregate3Value" }, potCtx(SETUP_V5)).ok).toBe(true);
  });

  test("register, setMetadata and setAgentWallet still refuse any value: sends_value", () => {
    const registry: [WriteRequest, CallContext][] = [
      [registerCall(config, null), { ...ctx, pot: SETUP_V5 }],
      [registerCall(config, "https://example.com/agent.json"), { ...ctx, pot: SETUP_V5 }],
      [goodPointer(), { ...ctx, pot: SETUP_V5 }],
      [goodWallet(), { ...walletCtx(), pot: SETUP_V5 }],
    ];
    for (const [req, c] of registry) {
      for (const value of [BigInt(1), setup.value as bigint])
        expect(allowedCall({ ...req, value }, c)).toEqual(refused("sends_value"));
      // A pot context changes nothing for them.
      expect(allowedCall(req, c).ok).toBe(true);
    }
  });
});

describe("sendAllowedCall, the pot's calls", () => {
  const wallet = () => vi.fn<(req: WriteRequest) => Promise<Hex>>(async () => "0xabc");
  const pots: [string, WriteRequest, CallContext][] = [
    ["the setup", setupReq(), potCtx(SETUP_V5)],
    ["a change", execReq(CHANGE_V6), potCtx(CHANGE_V6)],
    ["a stop", execReq(STOP_V9), potCtx(STOP_V9)],
    ["a take back", execReq(WITHDRAW_V10), potCtx(WITHDRAW_V10)],
    ["a restore", execReq(RESTORE_V12), potCtx(RESTORE_V12)],
  ];

  test("sendAllowedCall refuses a pot call from another connected account, and with no account: wallet_is_not_the_guardian, and writeContract is not called", async () => {
    const writeContract = wallet();
    for (const [, req, c] of pots) {
      for (const walletAddress of [GUARDIAN, A, P, REAL_SAFE, ZERO, undefined, "" as Address]) {
        expect(
          await sendAllowedCall(req, c, { walletChainId: CHAIN, walletAddress, configuredChainIds: [CHAIN], writeContract }),
        ).toEqual(refused("wallet_is_not_the_guardian"));
      }
      // No account named at all.
      expect(await sendAllowedCall(req, c, { walletChainId: CHAIN, configuredChainIds: [CHAIN], writeContract })).toEqual(
        refused("wallet_is_not_the_guardian"),
      );
    }
    expect(writeContract).not.toHaveBeenCalled();
  });

  test("the guardian's own account, in any letter case, sends each pot call once", async () => {
    for (const [, req, c] of pots) {
      for (const walletAddress of [G, lower(G), upper(G)]) {
        const writeContract = wallet();
        const out = await sendAllowedCall(req, c, { walletChainId: CHAIN, walletAddress, configuredChainIds: [CHAIN], writeContract });
        expect(out).toEqual({ ok: true, hash: "0xabc", data: accepted(req, c) });
        expect(writeContract).toHaveBeenCalledTimes(1);
      }
    }
  });

  test("sendAllowedCall refuses a pot call when the wallet is on another chain: wallet_on_another_chain", async () => {
    const writeContract = wallet();
    for (const [, req, c] of pots) {
      for (const walletChainId of [1, OTHER_CHAIN, undefined]) {
        // Read before the account: on another chain and from another account, the chain is said.
        for (const walletAddress of [G, GUARDIAN, undefined]) {
          expect(
            await sendAllowedCall(req, c, { walletChainId, walletAddress, configuredChainIds: [CHAIN], writeContract }),
          ).toEqual(refused("wallet_on_another_chain"));
        }
      }
      expect(
        await sendAllowedCall(req, c, { walletChainId: CHAIN, walletAddress: GUARDIAN, configuredChainIds: [OTHER_CHAIN], writeContract }),
      ).toEqual(refused("chain_not_configured"));
    }
    expect(writeContract).not.toHaveBeenCalled();
  });

  test("a refused pot call never reaches the wallet, and the allowlist speaks first", async () => {
    const writeContract = wallet();
    const req = { ...setupReq(), value: BigInt(1) };
    expect(
      await sendAllowedCall(req, potCtx(SETUP_V5), { walletChainId: 1, walletAddress: GUARDIAN, configuredChainIds: [], writeContract }),
    ).toEqual(refused("value_mismatch"));
    expect(
      await sendAllowedCall(execReq(RESTORE_V11), potCtx(RESTORE_V13), { walletChainId: CHAIN, walletAddress: G, configuredChainIds: [CHAIN], writeContract }),
    ).toEqual(refused("exec_args"));
    expect(writeContract).not.toHaveBeenCalled();
  });

  test("sendAllowedCall forwards the rebuilt arguments, the pinned ABI, the value and the gas, and nothing else", async () => {
    // wagmi reads the request's variables a tick later, after its own `onMutate`.
    let seen: Call3Value[] = [];
    const writeContract = vi.fn<(r: WriteRequest) => Promise<Hex>>(async (r) => {
      await Promise.resolve();
      seen = (r.args[0] as Call3Value[]).map((c) => ({ ...c }));
      return "0xabc";
    });
    // The caller's calls in another letter case, and its request padded with keys never read.
    const mine = callsOf(setupReq()).map((c) => ({ ...c, target: lower(c.target), callData: upper(c.callData) as Hex }));
    const args: unknown[] = [mine];
    const padded = {
      ...setupReq(),
      address: lower(T.multicall3),
      args,
      account: GUARDIAN,
      dataSuffix: "0xdeadbeef",
      nonce: 7,
    } as WriteRequest;
    const pending = sendAllowedCall(padded, potCtx(SETUP_V5), {
      walletChainId: CHAIN,
      walletAddress: G,
      configuredChainIds: [CHAIN],
      writeContract,
    });
    // The caller changes its own objects while the wallet opens.
    mine[1].target = ANOTHER_CONTRACT;
    mine[2].value = BigInt(1);
    mine.push({ ...mine[1] });
    args.push("0x");
    const out = await pending;
    expect(out).toEqual({ ok: true, hash: "0xabc", data: accepted(setupReq(), potCtx(SETUP_V5)) });
    expect(writeContract).toHaveBeenCalledTimes(1);
    const sent = writeContract.mock.calls[0][0];
    expect(sent).toEqual(setupReq());
    expect(sent.abi).toBe(multicall3Abi);
    expect(sent.value).toBe(BigInt("60100000000000000000"));
    expect(sent.gas).toBe(SETUP_GAS);
    expect(sent.address).toBe(T.multicall3);
    expect(Object.keys(sent).sort()).toEqual(["abi", "address", "args", "chainId", "functionName", "gas", "value"]);
    expect(sent.args).not.toBe(args);
    expect(sent.args[0]).not.toBe(mine);
    expect(seen).toEqual(callsOf(setupReq()));
  });

  test("an action: the wallet gets the ten rebuilt arguments, the pot checksummed, the pinned ABI and the gas", async () => {
    for (const [, req, c] of pots.slice(1)) {
      let seen: unknown[] = [];
      const writeContract = vi.fn<(r: WriteRequest) => Promise<Hex>>(async (r) => {
        await Promise.resolve();
        seen = [...r.args];
        return "0xabc";
      });
      const args = [...req.args];
      args[2] = upper(args[2] as string);
      const padded = { ...req, address: lower(REAL_SAFE), args, account: GUARDIAN, value: NO_WEI } as WriteRequest;
      const pending = sendAllowedCall(padded, c, { walletChainId: CHAIN, walletAddress: G, configuredChainIds: [CHAIN], writeContract });
      args[0] = ANOTHER_CONTRACT;
      args.push("0x");
      expect((await pending).ok).toBe(true);
      const sent = writeContract.mock.calls[0][0];
      expect(sent).toEqual({ ...req, value: NO_WEI });
      expect(sent.abi).toBe(safeAbi);
      expect(sent.address).toBe(REAL_SAFE);
      expect(Object.keys(sent).sort()).toEqual(["abi", "address", "args", "chainId", "functionName", "gas", "value"]);
      expect(seen).toEqual([...req.args]);
      expect(sent.args).not.toBe(args);
    }
    // With no value, none is sent.
    const writeContract = wallet();
    await sendAllowedCall(execReq(STOP_V9), potCtx(STOP_V9), { walletChainId: CHAIN, walletAddress: G, configuredChainIds: [CHAIN], writeContract });
    expect(writeContract).toHaveBeenCalledWith(execReq(STOP_V9));
    expect("value" in writeContract.mock.calls[0][0]).toBe(false);
  });

  test("the registry's calls ask for no connected account: the account rule is the pot's alone", async () => {
    for (const walletAddress of [undefined, GUARDIAN, A]) {
      const writeContract = wallet();
      const out = await sendAllowedCall(goodPointer(), { ...ctx, pot: SETUP_V5 }, {
        walletChainId: CHAIN,
        walletAddress,
        configuredChainIds: [CHAIN],
        writeContract,
      });
      expect(out.ok).toBe(true);
      expect(writeContract).toHaveBeenCalledWith(goodPointer());
    }
  });
});

describe("agentIdFromMint", () => {
  const word = (hex: string) => `0x${hex.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
  const mint = (over: Partial<{ address: string; from: string; to: string; id: bigint }> = {}) => ({
    address: over.address ?? REGISTRY,
    topics: [
      TRANSFER_TOPIC,
      word(over.from ?? "0"),
      word(over.to ?? GUARDIAN),
      word((over.id ?? BigInt(LIVE_AGENT)).toString(16)),
    ],
  });
  const at = { registry: REGISTRY, owner: GUARDIAN };
  const unrelated = { address: ANOTHER_CONTRACT, topics: [`0x${"11".repeat(32)}`] };

  test("a register receipt gives the minted id", () => {
    expect(agentIdFromMint({ status: "success", logs: [unrelated, mint()] }, at)).toBe("897126");
  });

  test("addresses and topics in another case", () => {
    const loud = mint();
    const shouted = {
      address: lower(REGISTRY),
      topics: loud.topics.map((t) => `0x${t.slice(2).toUpperCase()}`),
    };
    expect(agentIdFromMint({ status: "success", logs: [shouted] }, { registry: REGISTRY, owner: lower(GUARDIAN) })).toBe(
      "897126",
    );
  });

  test("an id past 2^53 keeps every digit", () => {
    const big = BigInt("123456789012345678901234567890");
    expect(agentIdFromMint({ status: "success", logs: [mint({ id: big })] }, at)).toBe(
      "123456789012345678901234567890",
    );
  });

  test("a receipt that names no status is read by its logs", () => {
    expect(agentIdFromMint({ logs: [mint()] }, at)).toBe("897126");
  });

  test.each<[string, { status?: string; logs: { address: string; topics: string[] }[] }]>([
    ["a reverted receipt", { status: "reverted", logs: [mint()] }],
    ["a Transfer whose sender is not zero (not a mint)", { status: "success", logs: [mint({ from: OTHER_WALLET })] }],
    ["a Transfer from another contract", { status: "success", logs: [mint({ address: ANOTHER_CONTRACT })] }],
    ["a mint to another wallet", { status: "success", logs: [mint({ to: OTHER_WALLET })] }],
    ["two mints", { status: "success", logs: [mint(), mint({ id: BigInt(2) })] }],
    ["two mints, one to another wallet", { status: "success", logs: [mint(), mint({ to: OTHER_WALLET })] }],
    ["no logs", { status: "success", logs: [] }],
    ["another event", { status: "success", logs: [{ ...mint(), topics: [`0x${"22".repeat(32)}`, ...mint().topics.slice(1)] }] }],
    ["three topics", { status: "success", logs: [{ ...mint(), topics: mint().topics.slice(0, 3) }] }],
    [
      "a recipient word with bytes above the address",
      { status: "success", logs: [{ ...mint(), topics: [TRANSFER_TOPIC, word("0"), `0x${"ff".repeat(12)}${GUARDIAN.slice(2).toLowerCase()}`, word("1")] }] },
    ],
    [
      "an id that is not a word",
      { status: "success", logs: [{ ...mint(), topics: [TRANSFER_TOPIC, word("0"), word(GUARDIAN), "0x1"] }] },
    ],
  ])("null for %s", (_name, receipt) => {
    expect(agentIdFromMint(receipt, at)).toBeNull();
  });
});
