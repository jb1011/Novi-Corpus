import {
  type Abi,
  type Address,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  type Hex,
  HttpRequestError,
  type PublicClient,
  isAddressEqual,
  toFunctionSelector,
  zeroAddress,
  zeroHash,
} from "viem";
import { expect, test } from "vitest";
import {
  CONTROLLER_GRANTED_SELECTORS,
  LEGAL_BODY_GRANTED_SELECTORS,
  assertLegalBodyContractFacts,
  assertLegalBodyFactoryWiring,
  selectorRole,
} from "../../../src/adapters/arc/bootVerify";
import { standingRoles } from "../../../src/monitor/events";

const CONTROLLER = "0x9526E228E94A125843B2d010c1155780CBBAFb5c" as Address;
const LB_FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as Address;
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address;
const EXECUTOR = "0x000000000000000000000000000000000000000b" as Address;
const OTHER = "0x00000000000000000000000000000000000000ff" as Address;
const NO_CODE = "0x00000000000000000000000000000000000dead1" as Address;
const CHAIN_ID = 5042002;

test("the legal-body grant set is exactly the factory's two relayed functions, in order", () => {
  expect(LEGAL_BODY_GRANTED_SELECTORS.map((s) => s.name)).toEqual([
    "LegalBodyFactory.createLegalBody",
    "LegalBodyFactory.scheduleOperatingAgreementUpdate",
  ]);
  expect(LEGAL_BODY_GRANTED_SELECTORS[0]!.selector).toBe(
    toFunctionSelector("createLegalBody(uint256,address,uint256,bytes32,uint256,bytes)"),
  );
  expect(LEGAL_BODY_GRANTED_SELECTORS[1]!.selector).toBe(
    toFunctionSelector("scheduleOperatingAgreementUpdate(address,bytes32,uint256,bytes)"),
  );
});

test("no legal-body selector collides with a standing controller grant", () => {
  const standing = new Set(CONTROLLER_GRANTED_SELECTORS.map((s) => s.selector));
  for (const s of LEGAL_BODY_GRANTED_SELECTORS) expect(standing.has(s.selector)).toBe(false);
});

test("the monitor treats the two legal-body grants as standing roles (WARN, not CRITICAL)", () => {
  const roles = standingRoles();
  expect(roles.size).toBe(
    CONTROLLER_GRANTED_SELECTORS.length + LEGAL_BODY_GRANTED_SELECTORS.length,
  );
  for (const s of LEGAL_BODY_GRANTED_SELECTORS)
    expect(roles.has(selectorRole(s.selector).toLowerCase() as `0x${string}`)).toBe(true);
});

const CREATE = LEGAL_BODY_GRANTED_SELECTORS[0]!;
const SCHEDULE = LEGAL_BODY_GRANTED_SELECTORS[1]!;

/**
 * What the chain holds. The boot check is a security gate, so the double has to be able to tell
 * WHICH contract, account and selector it was asked about: a check that read the owner from the
 * wrong contract, asked about the wrong account, or read one pin twice must fail these tests.
 */
interface World {
  owner: Address;
  pendingOwner: Address;
  registry: Address;
  /** The factory's typed-data domain, as `eip712Domain()` reports it. */
  domain: { name: string; version: string; chainId: bigint; verifyingContract: Address };
  /** selector -> the contract it is pinned to on the controller. Absent = never pinned. */
  pins: ReadonlyMap<Hex, Address>;
  /** The (selector, account) grants the controller holds. */
  grants: readonly (readonly [selector: Hex, account: Address])[];
  /** Every read fails with this, as a dead RPC would. */
  down?: Error;
}

const grantKey = (role: string, account: string) =>
  `${role.toLowerCase()}:${account.toLowerCase()}`;

/**
 * A small chain with two contracts. The factory's reads answer only at the factory address and
 * the controller's only at the controller address. Anything else fails the way the real client
 * does: "returned no data" at an address with no code, "reverted" at a contract that has no such
 * function. Pins are looked up by selector and grants by (role, account).
 */
function chain(over: Partial<World> = {}): PublicClient {
  const world: World = {
    owner: CONTROLLER,
    pendingOwner: zeroAddress,
    registry: REGISTRY,
    domain: {
      name: "Novi LegalBodyFactory",
      version: "1",
      chainId: BigInt(CHAIN_ID),
      verifyingContract: LB_FACTORY,
    },
    pins: new Map(LEGAL_BODY_GRANTED_SELECTORS.map((s) => [s.selector, LB_FACTORY])),
    grants: LEGAL_BODY_GRANTED_SELECTORS.map((s) => [s.selector, EXECUTOR] as const),
    ...over,
  };
  const granted = new Set(
    world.grants.map(([selector, account]) => grantKey(selectorRole(selector), account)),
  );
  const readContract = async (call: {
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
  }) => {
    if (world.down) throw world.down;
    const args = call.args ?? [];
    if (isAddressEqual(call.address, LB_FACTORY))
      switch (call.functionName) {
        case "owner":
          return world.owner;
        case "pendingOwner":
          return world.pendingOwner;
        case "identityRegistry":
          return world.registry;
        case "eip712Domain":
          // (fields, name, version, chainId, verifyingContract, salt, extensions)
          return [
            "0x0f",
            world.domain.name,
            world.domain.version,
            world.domain.chainId,
            world.domain.verifyingContract,
            zeroHash,
            [],
          ];
      }
    if (isAddressEqual(call.address, CONTROLLER))
      switch (call.functionName) {
        case "boundTarget":
          return world.pins.get((args[0] as string).toLowerCase() as Hex) ?? zeroAddress;
        case "hasRole":
          return granted.has(grantKey(args[0] as string, args[1] as string));
      }
    const { abi, functionName } = call;
    const hasCode = [LB_FACTORY, CONTROLLER].some((a) => isAddressEqual(a, call.address));
    throw new ContractFunctionExecutionError(
      hasCode
        ? // A custom error the ABI does not know, as a contract without this function answers.
          new ContractFunctionRevertedError({ abi, functionName, data: "0x972dd626" })
        : new ContractFunctionZeroDataError({ functionName }),
      { abi, functionName, args: call.args, contractAddress: call.address },
    );
  };
  return { readContract } as unknown as PublicClient;
}

const wiring = {
  factory: LB_FACTORY,
  controller: CONTROLLER,
  identityRegistry: REGISTRY,
  executor: EXECUTOR,
  chainId: CHAIN_ID,
};
const DOMAIN = {
  name: "Novi LegalBodyFactory",
  version: "1",
  chainId: BigInt(CHAIN_ID),
  verifyingContract: LB_FACTORY,
};

/** The message the boot check refuses with. Fails if it does not refuse. */
async function refusal(world: Partial<World>, p = wiring): Promise<string> {
  try {
    await assertLegalBodyFactoryWiring(chain(world), p);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the boot check to refuse, but it passed");
}

test("a fully wired legal-body factory verifies clean", async () => {
  await expect(assertLegalBodyFactoryWiring(chain(), wiring)).resolves.toBeUndefined();
});

test("a factory the controller does not own is refused, naming both env vars", async () => {
  expect(await refusal({ owner: OTHER })).toMatch(
    /LEGAL_BODY_FACTORY_ADDRESS.*owned by.*CONTROLLER_ADDRESS/s,
  );
});

test("a pending ownership handover is refused: the executor would lose its grants' target", async () => {
  expect(await refusal({ pendingOwner: OTHER })).toMatch(
    /ownership handover of LEGAL_BODY_FACTORY_ADDRESS.*pending/s,
  );
});

test("a factory bound to another identity registry is refused", async () => {
  expect(await refusal({ registry: OTHER })).toMatch(
    /LEGAL_BODY_FACTORY_ADDRESS.*identity registry.*IDENTITY_REGISTRY/s,
  );
});

test("a factory on another chain than the configured one is refused, naming ARC_CHAIN_ID", async () => {
  // The chain behind the RPC is not the one in the config: either side being wrong refuses.
  const onChain = await refusal({ domain: { ...DOMAIN, chainId: 1n } });
  expect(onChain).toMatch(/LEGAL_BODY_FACTORY_ADDRESS.*chain id 1\b.*ARC_CHAIN_ID 5042002/s);
  const inConfig = await refusal({}, { ...wiring, chainId: 1 });
  expect(inConfig).toMatch(/LEGAL_BODY_FACTORY_ADDRESS.*chain id 5042002\b.*ARC_CHAIN_ID 1\b/s);
});

test("a typed-data domain that verifies for another contract is refused", async () => {
  const message = await refusal({ domain: { ...DOMAIN, verifyingContract: OTHER } });
  expect(message).toMatch(/LEGAL_BODY_FACTORY_ADDRESS.*verifying contract/s);
  expect(message).toContain(OTHER);
});

test("a typed-data domain with another name is refused", async () => {
  const message = await refusal({ domain: { ...DOMAIN, name: "Novi LegalManagerFactory" } });
  expect(message).toMatch(/LEGAL_BODY_FACTORY_ADDRESS.*domain name/s);
  expect(message).toContain('"Novi LegalManagerFactory"');
  expect(message).toContain('"Novi LegalBodyFactory"');
});

test("a typed-data domain with another version is refused", async () => {
  const message = await refusal({ domain: { ...DOMAIN, version: "2" } });
  expect(message).toMatch(/LEGAL_BODY_FACTORY_ADDRESS.*domain version/s);
  expect(message).toContain('"2"');
  expect(message).toContain('"1"');
});

test("a pin set on only the first selector is refused, and the message names only the second", async () => {
  const message = await refusal({ pins: new Map([[CREATE.selector, LB_FACTORY]]) });
  expect(message).toMatch(/not pinned to LEGAL_BODY_FACTORY_ADDRESS/);
  expect(message).toContain(SCHEDULE.name);
  expect(message).not.toContain(CREATE.name);
});

test("a pin set on only the second selector is refused, and the message names only the first", async () => {
  const message = await refusal({ pins: new Map([[SCHEDULE.selector, LB_FACTORY]]) });
  expect(message).toMatch(/not pinned to LEGAL_BODY_FACTORY_ADDRESS/);
  expect(message).toContain(CREATE.name);
  expect(message).not.toContain(SCHEDULE.name);
});

test("a selector pinned to another contract is refused and named", async () => {
  const message = await refusal({
    pins: new Map([
      [CREATE.selector, OTHER],
      [SCHEDULE.selector, LB_FACTORY],
    ]),
  });
  expect(message).toMatch(/not pinned to LEGAL_BODY_FACTORY_ADDRESS/);
  expect(message).toContain(CREATE.name);
  expect(message).not.toContain(SCHEDULE.name);
});

test("a missing executor grant is refused, naming only that selector and the key", async () => {
  const message = await refusal({ grants: [[CREATE.selector, EXECUTOR]] });
  expect(message).toMatch(/PLATFORM_PRIVATE_KEY.*is missing.*CONTROLLER_ADDRESS/s);
  expect(message).toContain(SCHEDULE.name);
  expect(message).not.toContain(CREATE.name);
});

test("grants held by another account are refused", async () => {
  // Whoever else holds them (a stranger, the factory, the controller itself), the executor does
  // not, and the executor is the account that sends the relayed calls.
  for (const holder of [OTHER, LB_FACTORY, CONTROLLER]) {
    const message = await refusal({
      grants: LEGAL_BODY_GRANTED_SELECTORS.map((s) => [s.selector, holder] as const),
    });
    expect(message).toMatch(/PLATFORM_PRIVATE_KEY.*is missing/s);
    expect(message).toContain(EXECUTOR);
    expect(message).toContain(CREATE.name);
    expect(message).toContain(SCHEDULE.name);
  }
});

test("the grants are read for the configured executor, whichever account that is", async () => {
  const grants = LEGAL_BODY_GRANTED_SELECTORS.map((s) => [s.selector, OTHER] as const);
  await expect(
    assertLegalBodyFactoryWiring(chain({ grants }), { ...wiring, executor: OTHER }),
  ).resolves.toBeUndefined();
});

test("a factory address with no code is a wrong address, not an RPC outage", async () => {
  const message = await refusal({}, { ...wiring, factory: NO_CODE });
  expect(message).toContain(
    `LEGAL_BODY_FACTORY_ADDRESS ${NO_CODE} does not answer as a legal-body factory on this chain`,
  );
  expect(message).toContain("returned no data");
  expect(message).not.toMatch(/could not verify|RPC read failed/);
});

test("a contract that is not a legal-body factory is a wrong address, not an RPC outage", async () => {
  // The controller is a real contract, but it has no owner() to answer with.
  const message = await refusal({}, { ...wiring, factory: CONTROLLER });
  expect(message).toContain(
    `LEGAL_BODY_FACTORY_ADDRESS ${CONTROLLER} does not answer as a legal-body factory on this chain`,
  );
  // The cause is on one line, with the revert signature named once.
  expect(message).toMatch(/\(The contract function "\w+" reverted[^\n]*0x972dd626\)$/);
  expect(message.match(/0x972dd626/g)).toHaveLength(1);
  expect(message).not.toMatch(/could not verify|RPC read failed/);
});

test("a controller address that does not answer is named as the controller, not as the factory", async () => {
  const message = await refusal({}, { ...wiring, controller: NO_CODE });
  expect(message).toContain(`CONTROLLER_ADDRESS ${NO_CODE} does not answer as the controller`);
  expect(message).not.toMatch(/could not verify|does not answer as a legal-body factory/);
});

test("an RPC failure is reported as 'could not verify', never as misconfiguration", async () => {
  // The shape the real client throws when the transport fails, and a bare error for good measure.
  const transport = new ContractFunctionExecutionError(
    new HttpRequestError({ url: "http://127.0.0.1:1", details: "fetch failed" }),
    { abi: [], functionName: "owner", contractAddress: LB_FACTORY },
  );
  for (const down of [transport, new Error("socket hang up")]) {
    const message = await refusal({ down });
    expect(message).toMatch(/could not verify.*RPC read failed/s);
    expect(message).not.toContain("does not answer");
  }
});

/**
 * THE CONTRACT FACTS a pair's agreement states, proved at start. Two vectors: a factory, the code
 * it answers `implementation()` with, and the address of the minimal proxy to that code the
 * factory creates with a salt of 32 zero bytes. The second is a public testnet factory, where
 * `predictLegalBody(0)` answers that address.
 */
const VECTORS = [
  {
    factory: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    code: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    predicted: "0x9607306e6e88c09e86859847E039AF86D18c1FC7",
  },
  {
    factory: "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456",
    code: "0xc2e89ABf562f2EB366e4dde42325af16EeF542a6",
    predicted: "0xdd86Dca1D42E365eEAb5535078560e1098d7c722",
  },
] as const satisfies readonly { factory: Address; code: Address; predicted: Address }[];
type Vector = (typeof VECTORS)[number];

/** A function the contract does not have: the read reverts. */
const REVERTS = Symbol("reverts");
/** What one read answers: a value, a revert, or an error the node throws. */
type Answer = Address | bigint | typeof REVERTS | Error;

/** What the five reads of the facts answer, at the factory and at its code. */
interface FactAnswers {
  implementation: Answer;
  predictLegalBody: Answer;
  factoryMinDelay: Answer;
  factoryMaxDelay: Answer;
  codeMaxDelay: Answer;
}

const readKey = (address: string, functionName: string, args: readonly unknown[]) =>
  `${address.toLowerCase()} ${functionName}(${args.map(String).join(",")})`;

/**
 * A chain that answers by address, function name and arguments: the factory's four functions at
 * the factory, `MAX_AMENDMENT_DELAY()` at the code, `predictLegalBody` only for a salt of 32 zero
 * bytes. Every other read reverts, as a contract without that function answers.
 */
function factsChain(v: Vector, over: Partial<FactAnswers> = {}): PublicClient {
  const a: FactAnswers = {
    implementation: v.code,
    predictLegalBody: v.predicted,
    factoryMinDelay: 172_800n,
    factoryMaxDelay: 2_592_000n,
    codeMaxDelay: 31_536_000n,
    ...over,
  };
  const answers = new Map<string, Answer>([
    [readKey(v.factory, "implementation", []), a.implementation],
    [readKey(v.factory, "predictLegalBody", [zeroHash]), a.predictLegalBody],
    [readKey(v.factory, "MIN_AMENDMENT_DELAY", []), a.factoryMinDelay],
    [readKey(v.factory, "MAX_AMENDMENT_DELAY", []), a.factoryMaxDelay],
    [readKey(v.code, "MAX_AMENDMENT_DELAY", []), a.codeMaxDelay],
  ]);
  const readContract = async (call: {
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
  }) => {
    const answer = answers.get(readKey(call.address, call.functionName, call.args ?? []));
    if (answer instanceof Error) throw answer;
    if (answer !== undefined && answer !== REVERTS) return answer;
    const { abi, functionName } = call;
    throw new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({ abi, functionName, data: "0x972dd626" }),
      { abi, functionName, args: call.args, contractAddress: call.address },
    );
  };
  return { readContract } as unknown as PublicClient;
}

const factsOf = (v: Vector) => ({
  factory: v.factory,
  facts: "fixed_copy_cancellable_dissolution" as const,
  agreementVersion: "2026-11-draft-5",
});

test("the facts hold", async () => {
  for (const v of VECTORS)
    await expect(assertLegalBodyContractFacts(factsChain(v), factsOf(v))).resolves.toBeUndefined();
});

test.each<[string, Partial<FactAnswers>, string]>([
  [
    "1, implementation() reverts",
    { implementation: REVERTS },
    "boot: LEGAL_BODY_AGREEMENT_VERSION 2026-11-draft-5 cannot be served: LEGAL_BODY_FACTORY_ADDRESS 0x5FbDB2315678afecb367f032d93F642f64180aa3 does not answer implementation(), the code its legal bodies run",
  ],
  [
    "2, predictLegalBody(0) answers another address",
    { predictLegalBody: "0x000000000000000000000000000000000000dEaD" },
    "boot: LEGAL_BODY_AGREEMENT_VERSION 2026-11-draft-5 cannot be served: LEGAL_BODY_FACTORY_ADDRESS 0x5FbDB2315678afecb367f032d93F642f64180aa3 does not create each legal body as a fixed copy of the code at 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512, and this version is written for legal bodies whose code is never replaced",
  ],
  [
    "3, the factory's MAX_AMENDMENT_DELAY() answers 31536000",
    { factoryMaxDelay: 31_536_000n },
    "boot: LEGAL_BODY_AGREEMENT_VERSION 2026-11-draft-5 cannot be served: LEGAL_BODY_FACTORY_ADDRESS 0x5FbDB2315678afecb367f032d93F642f64180aa3 takes an amendment delay from 172800 to 31536000 seconds, and this version states 172800 to 2592000",
  ],
  [
    "4a, the code's MAX_AMENDMENT_DELAY() reverts",
    { codeMaxDelay: REVERTS },
    "boot: LEGAL_BODY_AGREEMENT_VERSION 2026-11-draft-5 cannot be served: the legal bodies of LEGAL_BODY_FACTORY_ADDRESS 0x5FbDB2315678afecb367f032d93F642f64180aa3 run code under which the wallet that started a dissolution cannot cancel it, and this version says the Guardian Wallet can",
  ],
  [
    "4b, the code's MAX_AMENDMENT_DELAY() answers 2592000",
    { codeMaxDelay: 2_592_000n },
    "boot: LEGAL_BODY_AGREEMENT_VERSION 2026-11-draft-5 cannot be served: the legal bodies of LEGAL_BODY_FACTORY_ADDRESS 0x5FbDB2315678afecb367f032d93F642f64180aa3 run code under which the wallet that started a dissolution cannot cancel it, and this version says the Guardian Wallet can",
  ],
])("a fact that does not hold refuses the start, read %s", async (_, over, message) => {
  const v = VECTORS[0];
  await expect(assertLegalBodyContractFacts(factsChain(v, over), factsOf(v))).rejects.toThrow(
    new Error(message),
  );
});

test("a node that cannot answer is a fault, not a refusal", async () => {
  const v = VECTORS[0];
  // The shape the real client throws when the transport fails, and a bare error for good measure.
  const transport = new ContractFunctionExecutionError(
    new HttpRequestError({ url: "http://127.0.0.1:1", details: "fetch failed" }),
    { abi: [], functionName: "implementation", contractAddress: v.factory },
  );
  for (const down of [transport, new Error("socket hang up")]) {
    const failed = await assertLegalBodyContractFacts(
      factsChain(v, { implementation: down }),
      factsOf(v),
    ).then(
      () => {
        throw new Error("expected the boot check to fail, but it passed");
      },
      (err: unknown) => err as Error,
    );
    expect(failed.message).toMatch(/could not verify.*RPC read failed/s);
    expect(failed.message).not.toContain("cannot be served");
    expect(failed.cause).toBe(down);
  }
});
