/**
 * The company's pot, the server's own copy: the per-chain table, the seven code hashes the start-up
 * check compares, the pinned fragments, the encodings (V1, V3 and V7 of the plan, the same vectors
 * the website's suite pins), the reading rules (`potReading`) and the ceiling's cap from a grant.
 *
 * The two packages share no code: the website's copy (`interface/src/lib/legalBody/safePot.ts` and
 * `safePotRules.ts`) is pinned to the same values in its own tests. The reading fixtures are the
 * website's too: HEALTHY is the proof's pot right after its first take (RESULTS.md, S6), and
 * REAL_STOPPED is the real Safe of the 24 Nov run (`0x0bbB...77EF`) as Arc testnet answered at block
 * 73,886,273, read only, after the run's stop (and the same again at block 73,899,377). A vector
 * or a reading that stops reproducing is a stop, never a new expected value.
 */
import {
  type Address,
  type Hex,
  decodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  size,
  toBytes,
  toFunctionSelector,
  zeroAddress,
} from "viem";
import { describe, expect, test } from "vitest";
import {
  type GrantSpend,
  POT_CEILING_MAX_USDC,
  POT_CODE_HASHES,
  POT_FEE_LOW_WEI,
  POT_PERIOD_MINUTES,
  POT_TAKE_GAS,
  type PotAddresses,
  PotBuildError,
  type PotRaw,
  type PotSetup,
  SAFE_FALLBACK_HANDLER_SLOT,
  SAFE_GUARD_SLOT,
  SAFE_PROXY_INIT_CODE_HASH,
  SAFE_PROXY_RUNTIME_CODE_HASH,
  SAFE_SENTINEL,
  USDC_UNIT,
  allowanceModuleAbi,
  erc20Abi,
  multiSendAbi,
  potAddresses,
  potCeilingCapFromGrant,
  potInitializer,
  potReading,
  predictPotAddress,
  safeAbi,
  takeCalldata,
} from "../../src/legalBody/safePot";

/** The real run of 24 Nov on Arc testnet: the guardian, the agent's key, the payee, the salt nonce,
 *  and the Safe it created. */
const G = "0x15D4EE6F84b6bf8ceE5A24cCb19FDF8257c22b0A" as const;
const A = "0x2dDcf8da463526614b9FA5E87Db259a3Bf06667C" as const;
const P = "0xE886e729CC5C43bE28642827C4e72e660A83C7E8" as const;
const SALT = 72231338869903870587851170785833461215n;
const SAFE_CREATED = "0x0bbBa174c1D6b6Edd2F1A86ff5af435B645b77EF" as const;
/** Inventions: another key, another Safe module, another contract. */
const X = "0x00000000000000000000000000000000000000aa" as const;
const OTHER_MODULE = "0x00000000000000000000000000000000000c0de1" as const;
const OTHER = "0x00000000000000000000000000000000000c0de2" as const;

const T = potAddresses(5042002) as PotAddresses;

/** V1's pot: a two-USDC ceiling over five minutes, as the real run set it. */
const V1: PotSetup = {
  guardian: G,
  agentWallet: A,
  token: T.usdc,
  ceilingUnits: 2_000_000n,
  periodMinutes: 5,
};
/** V3's pot: 50 USDC in each thirty-day period. */
const V3: PotSetup = { ...V1, ceilingUnits: 50_000_000n, periodMinutes: 43200 };

const pinned = (data: Hex, bytes: number, hash: Hex) => {
  expect(size(data)).toBe(bytes);
  expect(keccak256(data)).toBe(hash);
};

const lower = <T extends string>(x: T): T => x.toLowerCase() as T;
const upper = (x: Address): Address => `0x${x.slice(2).toUpperCase()}` as Address;

/** The real Safe's runtime code (171 bytes), read with `cast code` at block 73,886,273. */
const REAL_PROXY_CODE: Hex =
  "0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033";

describe("the addresses and the pinned values", () => {
  test("the table knows Arc mainnet and testnet with the same seven addresses, and no other chain", () => {
    expect(potAddresses(5042)).toEqual(potAddresses(5042002));
    expect(potAddresses(1)).toBeNull();
    expect(potAddresses(0)).toBeNull();
    expect(T).toEqual({
      safeSingleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
      proxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
      fallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
      multiSendCallOnly: "0xA83c336B20401Af773B6219BA5027174338D1836",
      allowanceModule: "0xAA46724893dedD72658219405185Fb0Fc91e091C",
      multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
      usdc: "0x3600000000000000000000000000000000000000",
    });
  });

  test("a caller that changes its copy of the table does not change the next answer", () => {
    const mine = potAddresses(5042002) as PotAddresses;
    mine.allowanceModule = OTHER_MODULE;
    expect(potAddresses(5042002)?.allowanceModule).toBe(
      "0xAA46724893dedD72658219405185Fb0Fc91e091C",
    );
  });

  test("the seven code hashes are the table's, by the table's names, and cannot be changed", () => {
    expect(POT_CODE_HASHES).toEqual({
      safeSingleton: "0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff",
      proxyFactory: "0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317",
      fallbackHandler: "0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9",
      multiSendCallOnly: "0xcdbdcec38d2f1c7d961b0029ff8416b7e86e9974d6f0e9c9580c7d17fcfb6663",
      allowanceModule: "0x7aa63affdca06fe94576f00077ad61a02ccf203a5da31e1b4ed595df7b65cf3e",
      multicall3: "0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891",
      usdc: "0xc9987bd3af6b26a030951faa7eacc017b68343aeedf3ce5fe68f821c4b93939d",
    });
    expect(Object.keys(POT_CODE_HASHES).sort()).toEqual(Object.keys(T).sort());
    expect(Object.isFrozen(POT_CODE_HASHES)).toBe(true);
  });

  test("the constants are the plan's", () => {
    expect(POT_PERIOD_MINUTES).toBe(43200);
    expect(POT_PERIOD_MINUTES).toBe(30 * 24 * 60);
    expect(USDC_UNIT).toBe(1_000_000n);
    expect(POT_CEILING_MAX_USDC).toBe(3_000_000_000);
    expect(POT_TAKE_GAS).toBe(200_000);
    expect(POT_FEE_LOW_WEI).toBe(10_000_000_000_000_000n);
    // The low mark: one take's gas limit at 50 gwei.
    expect(POT_FEE_LOW_WEI).toBe(BigInt(POT_TAKE_GAS) * 50_000_000_000n);
  });

  test("Safe's sentinel, its two storage slots and the proxy's two code hashes", () => {
    expect(SAFE_SENTINEL).toBe("0x0000000000000000000000000000000000000001");
    expect(SAFE_GUARD_SLOT).toBe(
      "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8",
    );
    expect(keccak256(toBytes("guard_manager.guard.address"))).toBe(SAFE_GUARD_SLOT);
    expect(SAFE_FALLBACK_HANDLER_SLOT).toBe(
      "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5",
    );
    expect(keccak256(toBytes("fallback_manager.handler.address"))).toBe(SAFE_FALLBACK_HANDLER_SLOT);
    expect(SAFE_PROXY_INIT_CODE_HASH).toBe(
      "0xe298282cefe913ab5d282047161268a8222e4bd4ed106300c547894bbefd31ee",
    );
    expect(SAFE_PROXY_RUNTIME_CODE_HASH).toBe(
      "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c",
    );
    // The real Safe's own code hashes to it.
    expect(size(REAL_PROXY_CODE)).toBe(171);
    expect(keccak256(REAL_PROXY_CODE)).toBe(SAFE_PROXY_RUNTIME_CODE_HASH);
  });
});

describe("the pinned fragments", () => {
  test("each is the proven script's signatures for the members the reads, the setup and the take use", () => {
    expect(safeAbi).toEqual(
      parseAbi([
        "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
        "function enableModule(address module)",
        "function getOwners() view returns (address[])",
        "function getThreshold() view returns (uint256)",
        "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
        "function getStorageAt(uint256 offset, uint256 length) view returns (bytes)",
        "function masterCopy() view returns (address)",
      ]),
    );
    expect(multiSendAbi).toEqual(parseAbi(["function multiSend(bytes transactions) payable"]));
    expect(allowanceModuleAbi).toEqual(
      parseAbi([
        "function addDelegate(address delegate)",
        "function setAllowance(address delegate, address token, uint96 allowanceAmount, uint16 resetTimeMin, uint32 resetBaseMin)",
        "function executeAllowanceTransfer(address safe, address token, address to, uint96 amount, address paymentToken, uint96 payment, address delegate, bytes signature)",
        "function getDelegates(address safe, uint48 start, uint8 pageSize) view returns (address[] results, uint48 next)",
        "function getTokens(address safe, address delegate) view returns (address[])",
        "function getTokenAllowance(address safe, address delegate, address token) view returns (uint256[5])",
      ]),
    );
    expect(erc20Abi).toEqual(
      parseAbi([
        "function balanceOf(address) view returns (uint256)",
        "function allowance(address _owner, address _spender) view returns (uint256 remaining)",
      ]),
    );
  });

  test("the proxy answers masterCopy itself: its selector is inside the real Safe's code", () => {
    const masterCopy = safeAbi.find((f) => f.name === "masterCopy");
    expect(masterCopy).toBeDefined();
    const selector = toFunctionSelector(masterCopy as (typeof safeAbi)[number]);
    expect(selector).toBe("0xa619486e");
    expect(REAL_PROXY_CODE).toContain(selector.slice(2));
  });
});

describe("the encodings", () => {
  test("V1: the initializer and the address of the Safe the real run created", () => {
    const init = potInitializer(T, V1);
    pinned(init, 964, "0x85e9c6994c94c27dde9801c8bc7e3ad95b8453d2ff43dc8955d666184b4526d8");
    expect(predictPotAddress(T, init, SALT)).toBe(SAFE_CREATED);
  });

  test("V3: the thirty-day initializer, and its address for salt nonce 1", () => {
    const init = potInitializer(T, V3);
    pinned(init, 964, "0x42ac0798ddc35bae68b07cc36a195960f5673107db1bcfa8a23c20153cef753a");
    expect(predictPotAddress(T, init, 1n)).toBe("0x4A13bC20E8596009CA37B897Aaf654C5e0b8e87D");
  });

  test("the setup: the guardian alone, threshold 1, the batch to MultiSendCallOnly v1.5.0, Safe's handler, no one paid", () => {
    const call = decodeFunctionData({ abi: safeAbi, data: potInitializer(T, V3) });
    expect(call.functionName).toBe("setup");
    const [owners, threshold, to, , handler, paymentToken, payment, receiver] =
      call.args as readonly [
        readonly Address[],
        bigint,
        Address,
        Hex,
        Address,
        Address,
        bigint,
        Address,
      ];
    expect(owners).toEqual([G]);
    expect(threshold).toBe(1n);
    expect(to).toBe(T.multiSendCallOnly);
    expect(handler).toBe(T.fallbackHandler);
    expect([paymentToken, payment, receiver]).toEqual([zeroAddress, 0n, zeroAddress]);
  });

  test("addresses in any letter case give the same bytes, and the predicted address comes back checksummed", () => {
    const init = potInitializer(T, V1);
    const lowerTable = Object.fromEntries(
      Object.entries(T).map(([k, v]) => [k, lower(v)]),
    ) as PotAddresses;
    expect(potInitializer(lowerTable, { ...V1, guardian: upper(G), agentWallet: lower(A) })).toBe(
      init,
    );
    expect(predictPotAddress(lowerTable, init, SALT)).toBe(SAFE_CREATED);
  });

  test("another singleton or another proxy factory: the prediction is refused, never a wrong address", () => {
    const init = potInitializer(T, V1);
    const otherSingleton = { ...T, safeSingleton: OTHER };
    const otherFactory = { ...T, proxyFactory: OTHER };
    expect(() => predictPotAddress(otherSingleton, init, SALT)).toThrow(PotBuildError);
    expect(() => predictPotAddress(otherFactory, init, SALT)).toThrow(PotBuildError);
    try {
      predictPotAddress(otherFactory, init, SALT);
    } catch (e) {
      expect((e as PotBuildError).problem).toBe("other_proxy_factory");
    }
    try {
      predictPotAddress(otherSingleton, init, SALT);
    } catch (e) {
      expect((e as PotBuildError).problem).toBe("other_singleton");
    }
  });

  test("V7: the agent's take is the take mined in the real run, with an empty signature", () => {
    const data = takeCalldata({
      pot: SAFE_CREATED,
      token: T.usdc,
      to: P,
      amountUnits: 1_000_000n,
      agentWallet: A,
    });
    pinned(data, 292, "0xdfe8f8bded62c4439e5dc86fdb9f39258afb89a2a0c10a65383c15ae626c24ec");
    const call = decodeFunctionData({ abi: allowanceModuleAbi, data });
    expect(call.functionName).toBe("executeAllowanceTransfer");
    expect(call.args).toEqual([SAFE_CREATED, T.usdc, P, 1_000_000n, zeroAddress, 0n, A, "0x"]);
    // Any letter case: the same bytes.
    expect(
      takeCalldata({
        pot: lower(SAFE_CREATED),
        token: upper(T.usdc),
        to: lower(P),
        amountUnits: 1_000_000n,
        agentWallet: upper(A),
      }),
    ).toBe(data);
  });
});

// ---------------------------------------------------------------------------------------------
// The reading rules: the website's fixtures and tests, the same answers
// ---------------------------------------------------------------------------------------------

const EXPECT = { addresses: T, guardian: G, agentWallet: A };

// The proof's own answers (RESULTS.md, S6), for a pot of guardian G and agent A:
const HEALTHY: PotRaw = {
  codeHash: SAFE_PROXY_RUNTIME_CODE_HASH,
  singleton: T.safeSingleton,
  owners: [G],
  threshold: 1n,
  modules: { list: [T.allowanceModule], next: SAFE_SENTINEL },
  guard: zeroAddress,
  fallbackHandler: T.fallbackHandler,
  delegates: { list: [A], next: 0 },
  tokens: [T.usdc],
  allowance: [50_000_000n, 10_000_000n, 43200n, 29919864n, 2n],
  usdcAllowanceToAgent: 0n,
  balanceUnits: 190_000_000n,
  balanceWei: 190_000_000_000_000_000_000n,
  agentBalanceWei: 100_000_000_000_000_000n,
  agentHasCode: false,
};

/** The agent key's fee money on the real run, at block 73,886,273: 0.000294 USDC. */
const REAL_AGENT_WEI = 294_000_000_000_000n;

// The real Safe as it reads today (24 Nov, after the run's stop): modules [], delegates [], tokens
// [USDC], allowance [0, 0, 0, 0, 3], balances 0, Safe's own handler, no guard, owner G, threshold 1.
const REAL_STOPPED: PotRaw = {
  ...HEALTHY,
  modules: { list: [], next: SAFE_SENTINEL },
  delegates: { list: [], next: 0 },
  allowance: [0n, 0n, 0n, 0n, 3n],
  balanceUnits: 0n,
  balanceWei: 0n,
  agentBalanceWei: REAL_AGENT_WEI,
};

const read = (raw: PotRaw) => potReading(raw, EXPECT);
const limitsNotRead = (problem: string, balanceUnits = HEALTHY.balanceUnits) => ({
  state: "limits_not_read",
  problem,
  balanceUnits,
});

describe("potReading: what a pot's raw facts let the record say", () => {
  test("a healthy pot reads its ceiling, what was taken, and the end of the period", () => {
    expect(potReading(HEALTHY, { addresses: T, guardian: G, agentWallet: A })).toEqual({
      state: "ceiling_read",
      ceilingUnits: 50_000_000n,
      spentUnits: 10_000_000n,
      periodEndsAt: (29919864 + 43200) * 60,
      nonce: 2n,
      balanceUnits: 190_000_000n,
    });
  });

  test("the real Safe after its stop reads stopped, module_off, holding 0", () => {
    expect(read(REAL_STOPPED)).toEqual({ state: "stopped", why: "module_off", balanceUnits: 0n });
  });

  // Rule 1.
  test("no code is absent, whatever else is held", () => {
    expect(read({ ...HEALTHY, codeHash: null })).toEqual({ state: "absent" });
    expect(read({ ...REAL_STOPPED, codeHash: null })).toEqual({ state: "absent" });
    expect(
      read({
        ...HEALTHY,
        codeHash: null,
        owners: [X],
        threshold: 2n,
        modules: { list: [OTHER_MODULE], next: OTHER_MODULE },
        guard: OTHER,
        usdcAllowanceToAgent: 1n,
      }),
    ).toEqual({ state: "absent" });
  });

  // Rule 2.
  test("another code hash, another singleton, a second owner, another owner, threshold 2: not_the_guardians", () => {
    const notTheGuardians = { state: "not_the_guardians" };
    const otherHash = keccak256("0x6000");
    expect(read({ ...HEALTHY, codeHash: otherHash })).toEqual(notTheGuardians);
    expect(read({ ...HEALTHY, singleton: OTHER })).toEqual(notTheGuardians);
    expect(read({ ...HEALTHY, singleton: zeroAddress })).toEqual(notTheGuardians);
    expect(read({ ...HEALTHY, owners: [G, X] })).toEqual(notTheGuardians);
    expect(read({ ...HEALTHY, owners: [X, G] })).toEqual(notTheGuardians);
    expect(read({ ...HEALTHY, owners: [X] })).toEqual(notTheGuardians);
    expect(read({ ...HEALTHY, owners: [] })).toEqual(notTheGuardians);
    expect(read({ ...HEALTHY, owners: [A] })).toEqual(notTheGuardians);
    expect(read({ ...HEALTHY, threshold: 2n })).toEqual(notTheGuardians);
    expect(read({ ...HEALTHY, threshold: 0n })).toEqual(notTheGuardians);
    // The same on a stopped pot: a Safe that is not the guardian's alone is never "stopped".
    expect(read({ ...REAL_STOPPED, owners: [G, X] })).toEqual(notTheGuardians);
  });

  test("the guardian compared in any letter case", () => {
    const ceiling = read(HEALTHY);
    expect(read({ ...HEALTHY, owners: [lower(G)] })).toEqual(ceiling);
    expect(potReading(HEALTHY, { ...EXPECT, guardian: lower(G) })).toEqual(ceiling);
    expect(potReading(HEALTHY, { ...EXPECT, guardian: upper(G) })).toEqual(ceiling);
    // And every other address and the code hash: hex is compared in lower case.
    expect(
      read({
        ...HEALTHY,
        codeHash: `0x${SAFE_PROXY_RUNTIME_CODE_HASH.slice(2).toUpperCase()}` as Hex,
        singleton: lower(T.safeSingleton),
        modules: { list: [lower(T.allowanceModule)], next: SAFE_SENTINEL },
        fallbackHandler: lower(T.fallbackHandler),
        delegates: { list: [lower(A)], next: 0 },
        tokens: [lower(T.usdc)],
      }),
    ).toEqual(ceiling);
    const lowerTable = Object.fromEntries(
      Object.entries(T).map(([k, v]) => [k, lower(v)]),
    ) as PotAddresses;
    expect(
      potReading(HEALTHY, { addresses: lowerTable, guardian: G, agentWallet: lower(A) }),
    ).toEqual(ceiling);
  });

  // Rule 3.
  test("a second module beside ours, another module alone, or a list that does not end at the sentinel: other_module, never stopped", () => {
    const otherModule = limitsNotRead("other_module");
    expect(
      read({
        ...HEALTHY,
        modules: { list: [T.allowanceModule, OTHER_MODULE], next: SAFE_SENTINEL },
      }),
    ).toEqual(otherModule);
    expect(
      read({
        ...HEALTHY,
        modules: { list: [OTHER_MODULE, T.allowanceModule], next: SAFE_SENTINEL },
      }),
    ).toEqual(otherModule);
    expect(read({ ...HEALTHY, modules: { list: [OTHER_MODULE], next: SAFE_SENTINEL } })).toEqual(
      otherModule,
    );
    // A page that says more follow: the module list goes on past what was read.
    expect(
      read({ ...HEALTHY, modules: { list: [T.allowanceModule], next: OTHER_MODULE } }),
    ).toEqual(otherModule);
    expect(read({ ...HEALTHY, modules: { list: [T.allowanceModule], next: zeroAddress } })).toEqual(
      otherModule,
    );
    // Another add-on alone could move the money: never "stopped", even with no delegate.
    expect(
      read({ ...REAL_STOPPED, modules: { list: [OTHER_MODULE], next: SAFE_SENTINEL } }),
    ).toEqual(limitsNotRead("other_module", 0n));
    expect(read({ ...REAL_STOPPED, modules: { list: [], next: OTHER_MODULE } })).toEqual(
      limitsNotRead("other_module", 0n),
    );
  });

  // Rules 4 and 5.
  test("a guard: guard_set; a fallback handler other than Safe's: other_handler", () => {
    expect(read({ ...HEALTHY, guard: OTHER })).toEqual(limitsNotRead("guard_set"));
    expect(read({ ...REAL_STOPPED, guard: OTHER })).toEqual(limitsNotRead("guard_set", 0n));
    expect(read({ ...HEALTHY, fallbackHandler: OTHER })).toEqual(limitsNotRead("other_handler"));
    expect(read({ ...HEALTHY, fallbackHandler: zeroAddress })).toEqual(
      limitsNotRead("other_handler"),
    );
    expect(read({ ...REAL_STOPPED, fallbackHandler: OTHER })).toEqual(
      limitsNotRead("other_handler", 0n),
    );
  });

  // Rule 6.
  test("an ERC-20 allowance of 1 unit from the pot to the agent's key: usdc_approved, on a healthy pot and on a stopped one", () => {
    expect(read({ ...HEALTHY, usdcAllowanceToAgent: 1n })).toEqual(limitsNotRead("usdc_approved"));
    expect(read({ ...REAL_STOPPED, usdcAllowanceToAgent: 1n })).toEqual(
      limitsNotRead("usdc_approved", 0n),
    );
    // A stop by removeDelegate is no stop either while the key holds an approval.
    expect(
      read({ ...HEALTHY, delegates: { list: [], next: 0 }, usdcAllowanceToAgent: 1n }),
    ).toEqual(limitsNotRead("usdc_approved"));
  });

  // Rule 7.
  test("after disableModule the module still answers [50000000, 5000000, 43200, ...] and the reading is stopped, module_off", () => {
    const disabled: PotRaw = {
      ...HEALTHY,
      modules: { list: [], next: SAFE_SENTINEL },
      allowance: [50_000_000n, 5_000_000n, 43200n, 29919864n, 3n],
    };
    expect(read(disabled)).toEqual({
      state: "stopped",
      why: "module_off",
      balanceUnits: HEALTHY.balanceUnits,
    });
    // Whatever the module still says of its delegates and tokens.
    expect(
      read({ ...disabled, delegates: { list: [X, A], next: 7 }, tokens: [zeroAddress] }),
    ).toEqual({ state: "stopped", why: "module_off", balanceUnits: HEALTHY.balanceUnits });
  });

  // Rule 8.
  test("after removeDelegate the token is still listed and the reading is stopped, no_delegate", () => {
    const removed: PotRaw = {
      ...HEALTHY,
      delegates: { list: [], next: 0 },
      tokens: [T.usdc],
      allowance: [0n, 0n, 0n, 0n, 2n],
    };
    expect(read(removed)).toEqual({
      state: "stopped",
      why: "no_delegate",
      balanceUnits: HEALTHY.balanceUnits,
    });
  });

  test("an empty delegates page that says more follow is never stopped: other_delegate", () => {
    // The pinned module cannot answer this; the rule refuses it all the same.
    expect(read({ ...HEALTHY, delegates: { list: [], next: 3 } })).toEqual(
      limitsNotRead("other_delegate"),
    );
  });

  // Rule 9.
  test("a second delegate, another delegate, a delegates page that says more follow: other_delegate", () => {
    const otherDelegate = limitsNotRead("other_delegate");
    expect(read({ ...HEALTHY, delegates: { list: [A, X], next: 0 } })).toEqual(otherDelegate);
    expect(read({ ...HEALTHY, delegates: { list: [X, A], next: 0 } })).toEqual(otherDelegate);
    expect(read({ ...HEALTHY, delegates: { list: [X], next: 0 } })).toEqual(otherDelegate);
    expect(read({ ...HEALTHY, delegates: { list: [A], next: 12 } })).toEqual(otherDelegate);
    // The guardian as the delegate is another delegate too.
    expect(read({ ...HEALTHY, delegates: { list: [G], next: 0 } })).toEqual(otherDelegate);
  });

  // Rule 9, Ruling R4.
  test("the agent's key that is the guardian's own: other_delegate, never a ceiling, in any letter case", () => {
    // That key, as the Safe's only owner, can take everything: no ceiling is read for it.
    const guardianAsAgent = { ...HEALTHY, delegates: { list: [G], next: 0 } };
    const reading = potReading(guardianAsAgent, { ...EXPECT, agentWallet: G });
    expect(reading.state).not.toBe("ceiling_read");
    expect(reading).toEqual(limitsNotRead("other_delegate"));
    expect(potReading(guardianAsAgent, { ...EXPECT, agentWallet: lower(G) })).toEqual(
      limitsNotRead("other_delegate"),
    );
    expect(
      potReading(
        { ...HEALTHY, owners: [lower(G)], delegates: { list: [lower(G)], next: 0 } },
        { ...EXPECT, agentWallet: G },
      ),
    ).toEqual(limitsNotRead("other_delegate"));
    expect(
      potReading(guardianAsAgent, { ...EXPECT, guardian: upper(G), agentWallet: lower(G) }),
    ).toEqual(limitsNotRead("other_delegate"));
  });

  // Rule 10.
  test("the native coin (token zero) listed beside USDC, or alone: other_token", () => {
    const otherToken = limitsNotRead("other_token");
    expect(read({ ...HEALTHY, tokens: [T.usdc, zeroAddress] })).toEqual(otherToken);
    expect(read({ ...HEALTHY, tokens: [zeroAddress, T.usdc] })).toEqual(otherToken);
    expect(read({ ...HEALTHY, tokens: [zeroAddress] })).toEqual(otherToken);
    expect(read({ ...HEALTHY, tokens: [OTHER] })).toEqual(otherToken);
    expect(read({ ...HEALTHY, tokens: [] })).toEqual(otherToken);
  });

  // Rule 11.
  test("a period of 5 minutes (the real run's test setting): other_period", () => {
    const five: PotRaw = {
      ...HEALTHY,
      allowance: [2_000_000n, 1_000_000n, 5n, 29923000n, 2n],
    };
    expect(read(five)).toEqual(limitsNotRead("other_period"));
    // A delegate whose allowance was zeroed has no period: nothing is read either.
    expect(read({ ...HEALTHY, allowance: [0n, 0n, 0n, 0n, 3n] })).toEqual(
      limitsNotRead("other_period"),
    );
    expect(
      read({ ...HEALTHY, allowance: [50_000_000n, 10_000_000n, 43201n, 29919864n, 2n] }),
    ).toEqual(limitsNotRead("other_period"));
  });

  // Rule 12.
  test("a ceiling of 0 is still ceiling_read, with 0", () => {
    const zero: PotRaw = { ...HEALTHY, allowance: [0n, 0n, 43200n, 29919864n, 1n] };
    expect(read(zero)).toEqual({
      state: "ceiling_read",
      ceilingUnits: 0n,
      spentUnits: 0n,
      periodEndsAt: (29919864 + 43200) * 60,
      nonce: 1n,
      balanceUnits: HEALTHY.balanceUnits,
    });
  });

  test("the end of the period is (lastResetMin + 43200) * 60, in unix seconds", () => {
    const reading = read({ ...HEALTHY, allowance: [1n, 0n, 43200n, 0n, 0n] });
    expect(reading).toMatchObject({ state: "ceiling_read", periodEndsAt: 43200 * 60 });
  });

  test("the first rule that applies decides", () => {
    // Rule 2 before rule 3: a Safe that is not the guardian's alone reads nothing, never a problem.
    expect(
      read({ ...HEALTHY, owners: [X], modules: { list: [OTHER_MODULE], next: SAFE_SENTINEL } }),
    ).toEqual({ state: "not_the_guardians" });
    // Rule 3 before rule 4, 4 before 5, 5 before 6.
    expect(
      read({ ...HEALTHY, modules: { list: [OTHER_MODULE], next: SAFE_SENTINEL }, guard: OTHER }),
    ).toEqual(limitsNotRead("other_module"));
    expect(read({ ...HEALTHY, guard: OTHER, fallbackHandler: OTHER })).toEqual(
      limitsNotRead("guard_set"),
    );
    expect(read({ ...HEALTHY, fallbackHandler: OTHER, usdcAllowanceToAgent: 5n })).toEqual(
      limitsNotRead("other_handler"),
    );
    // Rules 3 to 6 before 7 and 8: "stopped" only when nothing else could take.
    expect(read({ ...REAL_STOPPED, guard: OTHER, usdcAllowanceToAgent: 1n })).toEqual(
      limitsNotRead("guard_set", 0n),
    );
    // Rule 7 before 8, 8 before 9, 9 before 10, 10 before 11.
    expect(
      read({
        ...HEALTHY,
        modules: { list: [], next: SAFE_SENTINEL },
        delegates: { list: [], next: 0 },
      }),
    ).toEqual({ state: "stopped", why: "module_off", balanceUnits: HEALTHY.balanceUnits });
    expect(read({ ...HEALTHY, delegates: { list: [], next: 0 }, tokens: [zeroAddress] })).toEqual({
      state: "stopped",
      why: "no_delegate",
      balanceUnits: HEALTHY.balanceUnits,
    });
    expect(read({ ...HEALTHY, delegates: { list: [X], next: 0 }, tokens: [zeroAddress] })).toEqual(
      limitsNotRead("other_delegate"),
    );
    expect(read({ ...HEALTHY, tokens: [zeroAddress], allowance: [1n, 0n, 5n, 0n, 0n] })).toEqual(
      limitsNotRead("other_token"),
    );
  });

  test("a value of the wrong kind never reads as a pass", () => {
    // What a typed caller cannot hand in, but a fail-closed reading still refuses.
    const asRaw = (r: unknown) => r as PotRaw;
    expect(read(asRaw({ ...HEALTHY, threshold: 1 }))).toEqual({ state: "not_the_guardians" });
    expect(read(asRaw({ ...HEALTHY, codeHash: undefined }))).toEqual({
      state: "not_the_guardians",
    });
    expect(read(asRaw({ ...HEALTHY, usdcAllowanceToAgent: 0 }))).toEqual(
      limitsNotRead("usdc_approved"),
    );
    expect(read(asRaw({ ...HEALTHY, delegates: { list: [A], next: 0n } }))).toEqual(
      limitsNotRead("other_delegate"),
    );
    // Rule 8 asks for `next` 0 as a number too: an empty list with 0n is never stopped.
    expect(read(asRaw({ ...HEALTHY, delegates: { list: [], next: 0n } }))).toEqual(
      limitsNotRead("other_delegate"),
    );
    expect(read(asRaw({ ...HEALTHY, allowance: [1n, 0n, 43200, 1n, 1n] }))).toEqual(
      limitsNotRead("other_period"),
    );
    // Rule 12 reads the allowance's five facts as bigints, or reads no ceiling.
    const [amount, spent, resetTimeMin, lastResetMin, nonce] = HEALTHY.allowance;
    expect(
      read(
        asRaw({ ...HEALTHY, allowance: [50_000_000, spent, resetTimeMin, lastResetMin, nonce] }),
      ),
    ).toEqual(limitsNotRead("other_period"));
    expect(
      read(asRaw({ ...HEALTHY, allowance: [amount, spent, resetTimeMin, 29919864, nonce] })),
    ).toEqual(limitsNotRead("other_period"));
    expect(
      read(
        asRaw({ ...HEALTHY, allowance: [amount, 10_000_000, resetTimeMin, lastResetMin, nonce] }),
      ),
    ).toEqual(limitsNotRead("other_period"));
    expect(
      read(asRaw({ ...HEALTHY, allowance: [amount, spent, resetTimeMin, lastResetMin, 2] })),
    ).toEqual(limitsNotRead("other_period"));
    expect(
      read(asRaw({ ...HEALTHY, allowance: [amount, spent, resetTimeMin, lastResetMin] })),
    ).toEqual(limitsNotRead("other_period"));
    // An empty string is not an empty list: never "stopped".
    expect(read(asRaw({ ...HEALTHY, modules: { list: "", next: SAFE_SENTINEL } }))).toEqual(
      limitsNotRead("other_module"),
    );
    expect(read(asRaw({ ...HEALTHY, delegates: { list: "", next: 0 } }))).toEqual(
      limitsNotRead("other_delegate"),
    );
    // An address that is not a string is never the expected one, and never throws.
    expect(read(asRaw({ ...HEALTHY, guard: undefined }))).toEqual(limitsNotRead("guard_set"));
    expect(read(asRaw({ ...HEALTHY, owners: [7] }))).toEqual({ state: "not_the_guardians" });
  });

  test("Ruling R6: an allowance that is not a list of five reads other_period, and never throws", () => {
    const asRaw = (r: unknown) => r as PotRaw;
    const healthy = [...HEALTHY.allowance];
    for (const [label, allowance] of [
      ["missing", undefined],
      ["null", null],
      ["a number", 43200n],
      ["an object", {}],
      ["an object with five numbered fields", { 0: 1n, 1: 0n, 2: 43200n, 3: 1n, 4: 1n, length: 5 }],
      ["a set of the five", new Set(healthy)],
      ["a list of six", [...healthy, 0n]],
      ["a list of four", healthy.slice(0, 4)],
      ["a string", "43200"],
    ] as const)
      expect(read(asRaw({ ...HEALTHY, allowance })), label).toEqual(limitsNotRead("other_period"));
    // The list of five still reads its ceiling.
    expect(read(asRaw({ ...HEALTHY, allowance: healthy }))).toMatchObject({ state: "ceiling_read" });
  });
});

// ---------------------------------------------------------------------------------------------
// The ceiling's cap from a grant
// ---------------------------------------------------------------------------------------------

const NO: GrantSpend = { allowed: false };
const spend = (per30Days: number, perAct = 1): GrantSpend => ({
  allowed: true,
  perAct,
  per30Days,
  above: "guardian_signature",
});
const grant = (
  acts: { buy: GrantSpend; pay: GrantSpend; engageContractor: GrantSpend },
  endsOn: string | null = null,
) => ({ choices: { acts, endsOn } });

describe("potCeilingCapFromGrant: the most the ceiling field takes", () => {
  test("null is none; buy 100 and pay 250 allowed, contractor not, is capped 350 with its end day; none allowed is no_spending", () => {
    expect(potCeilingCapFromGrant(null)).toEqual({ kind: "none" });
    expect(
      potCeilingCapFromGrant(
        grant({ buy: spend(100, 40), pay: spend(250, 250), engageContractor: NO }, "2027-01-31"),
      ),
    ).toEqual({ kind: "capped", maxUsdc: 350, endsOn: "2027-01-31" });
    expect(potCeilingCapFromGrant(grant({ buy: NO, pay: NO, engageContractor: NO }))).toEqual({
      kind: "no_spending",
    });
    expect(
      potCeilingCapFromGrant(grant({ buy: NO, pay: NO, engageContractor: NO }, "2027-01-31")),
    ).toEqual({ kind: "no_spending" });
  });

  test("each kind alone, and the three at the grant's largest amount reach the field's own maximum", () => {
    expect(
      potCeilingCapFromGrant(grant({ buy: NO, pay: NO, engageContractor: spend(75) })),
    ).toEqual({ kind: "capped", maxUsdc: 75, endsOn: null });
    expect(potCeilingCapFromGrant(grant({ buy: spend(1), pay: NO, engageContractor: NO }))).toEqual(
      {
        kind: "capped",
        maxUsdc: 1,
        endsOn: null,
      },
    );
    const max = 1_000_000_000;
    expect(
      potCeilingCapFromGrant(
        grant({ buy: spend(max), pay: spend(max), engageContractor: spend(max) }),
      ),
    ).toEqual({ kind: "capped", maxUsdc: POT_CEILING_MAX_USDC, endsOn: null });
  });

  test("the amount per act is not the cap: the thirty-day amounts are", () => {
    expect(
      potCeilingCapFromGrant(
        grant({ buy: spend(500, 10), pay: spend(20, 20), engageContractor: NO }),
      ),
    ).toEqual({ kind: "capped", maxUsdc: 520, endsOn: null });
  });

  test("a setting that is not a whole thirty-day amount from 1 to 1,000,000,000 adds nothing, never more", () => {
    const odd = (s: unknown) => s as GrantSpend;
    const pay = spend(250);
    const cases: unknown[] = [
      { allowed: true, perAct: 1, per30Days: "100", above: "guardian_signature" },
      { allowed: true, perAct: 1, per30Days: Number.NaN, above: "guardian_signature" },
      {
        allowed: true,
        perAct: 1,
        per30Days: Number.POSITIVE_INFINITY,
        above: "guardian_signature",
      },
      { allowed: true, perAct: 1, per30Days: 0, above: "guardian_signature" },
      { allowed: true, perAct: 1, per30Days: -100, above: "guardian_signature" },
      { allowed: true, perAct: 1, per30Days: 1.5, above: "guardian_signature" },
      { allowed: true, perAct: 1, per30Days: 1_000_000_001, above: "guardian_signature" },
      { allowed: true, perAct: 1, per30Days: 100n, above: "guardian_signature" },
      { allowed: true, perAct: 1, above: "guardian_signature" },
      { allowed: "true", perAct: 1, per30Days: 100, above: "guardian_signature" },
      { allowed: false, per30Days: 100 },
      null,
      undefined,
    ];
    for (const buy of cases)
      expect(potCeilingCapFromGrant(grant({ buy: odd(buy), pay, engageContractor: NO }))).toEqual({
        kind: "capped",
        maxUsdc: 250,
        endsOn: null,
      });
    // A grant without its choices or its acts is no grant: none, never a throw.
    const broken = (g: unknown) => g as Parameters<typeof potCeilingCapFromGrant>[0];
    for (const g of [
      {},
      { choices: null },
      { choices: {} },
      { choices: { acts: null, endsOn: null } },
      { choices: { endsOn: "2027-01-31" } },
      "grant",
      7,
    ])
      expect(potCeilingCapFromGrant(broken(g))).toEqual({ kind: "none" });
    expect(potCeilingCapFromGrant(broken(undefined))).toEqual({ kind: "none" });
    // Nothing left that allows spending: no spending.
    expect(
      potCeilingCapFromGrant(grant({ buy: odd(cases[0]), pay: NO, engageContractor: NO })),
    ).toEqual({ kind: "no_spending" });
  });
});
