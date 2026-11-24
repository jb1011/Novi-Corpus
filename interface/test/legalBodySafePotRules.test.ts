/**
 * The company's pot, as read: the reading rules (`potReading`), the browser's read of a pot's raw
 * facts (`readPotRaw`), and the ceiling's cap from a grant (`potCeilingCapFromGrant`).
 *
 * The fixtures are the answers the proof and the real Safe gave. HEALTHY is the proof's pot right
 * after its first take (RESULTS.md, S6). REAL_STOPPED and the read client's answers are the real
 * Safe of the 24 Nov run (`0x0bbB...77EF`) as Arc testnet answered at block 73,886,273 on 24 Nov,
 * read only with `cast call`, `cast code` and `cast balance` after the run's stop: no module, no
 * delegate, USDC still listed, the allowance zeroed but for its nonce 3, nothing in it.
 *
 * Each rule of `potReading` has its own test, and a stop the rules miss is a stop, never a new
 * expected value: what these readings decide is what the public record will claim.
 */
import { describe, expect, test, vi } from "vitest";
import { encodeFunctionData, isAddress, keccak256, zeroAddress, type PublicClient } from "viem";
import {
  allowanceModuleAbi,
  erc20Abi,
  POT_CEILING_MAX_USDC,
  potAddresses,
  SAFE_FALLBACK_HANDLER_SLOT,
  SAFE_GUARD_SLOT,
  SAFE_PROXY_RUNTIME_CODE_HASH,
  SAFE_SENTINEL,
  safeAbi,
  type PotAddresses,
} from "@/lib/legalBody/safePot";
import {
  potCeilingCapFromGrant,
  potReading,
  readPotRaw,
  type GrantSpend,
  type PotRaw,
} from "@/lib/legalBody/safePotRules";
import type { Address, Hex } from "@/lib/api/types";

/** The real run of 24 Nov: the guardian, the agent's key, and the Safe it created. */
const G = "0x15D4EE6F84b6bf8ceE5A24cCb19FDF8257c22b0A" as const;
const A = "0x2dDcf8da463526614b9FA5E87Db259a3Bf06667C" as const;
const SAFE_CREATED = "0x0bbBa174c1D6b6Edd2F1A86ff5af435B645b77EF" as const;
/** Inventions: another key, another Safe module, another contract. */
const X = "0x00000000000000000000000000000000000000aa" as const;
const OTHER_MODULE = "0x00000000000000000000000000000000000c0de1" as const;
const OTHER = "0x00000000000000000000000000000000000c0de2" as const;

const T = potAddresses(5042002) as PotAddresses;
const EXPECT = { addresses: T, guardian: G, agentWallet: A };

// The proof's own answers (RESULTS.md, S6), for a pot of guardian G and agent A:
const HEALTHY: PotRaw = {
  codeHash: SAFE_PROXY_RUNTIME_CODE_HASH,
  singleton: T.safeSingleton,
  owners: [G],
  threshold: BigInt(1),
  modules: { list: [T.allowanceModule], next: SAFE_SENTINEL },
  guard: zeroAddress,
  fallbackHandler: T.fallbackHandler,
  delegates: { list: [A], next: 0 },
  tokens: [T.usdc],
  allowance: [BigInt(50_000_000), BigInt(10_000_000), BigInt(43200), BigInt(29919864), BigInt(2)],
  usdcAllowanceToAgent: BigInt(0),
  balanceUnits: BigInt(190_000_000),
  balanceWei: BigInt("190000000000000000000"),
  agentBalanceWei: BigInt("100000000000000000"),
  agentHasCode: false,
};

/** The agent key's fee money on the real run, at block 73,886,273: 0.000294 USDC. */
const REAL_AGENT_WEI = BigInt("294000000000000");

// The real Safe as it reads today (24 Nov, after the run's stop): modules [], delegates [], tokens
// [USDC], allowance [0, 0, 0, 0, 3], balances 0, Safe's own handler, no guard, owner G, threshold 1.
const REAL_STOPPED: PotRaw = {
  ...HEALTHY,
  modules: { list: [], next: SAFE_SENTINEL },
  delegates: { list: [], next: 0 },
  allowance: [BigInt(0), BigInt(0), BigInt(0), BigInt(0), BigInt(3)],
  balanceUnits: BigInt(0),
  balanceWei: BigInt(0),
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
      ceilingUnits: BigInt(50_000_000),
      spentUnits: BigInt(10_000_000),
      periodEndsAt: (29919864 + 43200) * 60,
      nonce: BigInt(2),
      balanceUnits: BigInt(190_000_000),
    });
  });

  test("the real Safe after its stop reads stopped, module_off, holding 0", () => {
    expect(read(REAL_STOPPED)).toEqual({ state: "stopped", why: "module_off", balanceUnits: BigInt(0) });
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
        threshold: BigInt(2),
        modules: { list: [OTHER_MODULE], next: OTHER_MODULE },
        guard: OTHER,
        usdcAllowanceToAgent: BigInt(1),
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
    expect(read({ ...HEALTHY, threshold: BigInt(2) })).toEqual(notTheGuardians);
    expect(read({ ...HEALTHY, threshold: BigInt(0) })).toEqual(notTheGuardians);
    // The same on a stopped pot: a Safe that is not the guardian's alone is never "stopped".
    expect(read({ ...REAL_STOPPED, owners: [G, X] })).toEqual(notTheGuardians);
  });

  test("the guardian compared in any letter case", () => {
    const ceiling = read(HEALTHY);
    expect(read({ ...HEALTHY, owners: [G.toLowerCase() as Address] })).toEqual(ceiling);
    expect(potReading(HEALTHY, { ...EXPECT, guardian: G.toLowerCase() as Address })).toEqual(ceiling);
    expect(
      potReading(HEALTHY, { ...EXPECT, guardian: `0x${G.slice(2).toUpperCase()}` as Address }),
    ).toEqual(ceiling);
    // And every other address and the code hash: hex is compared in lower case.
    const lower = (a: Address) => a.toLowerCase() as Address;
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
    const lowerAddresses = Object.fromEntries(
      Object.entries(T).map(([k, v]) => [k, lower(v)]),
    ) as PotAddresses;
    expect(potReading(HEALTHY, { addresses: lowerAddresses, guardian: G, agentWallet: lower(A) })).toEqual(
      ceiling,
    );
  });

  // Rule 3.
  test("a second module beside ours, another module alone, or a list that does not end at the sentinel: other_module, never stopped", () => {
    const otherModule = limitsNotRead("other_module");
    expect(read({ ...HEALTHY, modules: { list: [T.allowanceModule, OTHER_MODULE], next: SAFE_SENTINEL } })).toEqual(
      otherModule,
    );
    expect(read({ ...HEALTHY, modules: { list: [OTHER_MODULE, T.allowanceModule], next: SAFE_SENTINEL } })).toEqual(
      otherModule,
    );
    expect(read({ ...HEALTHY, modules: { list: [OTHER_MODULE], next: SAFE_SENTINEL } })).toEqual(otherModule);
    // A page that says more follow: the module list goes on past what was read.
    expect(read({ ...HEALTHY, modules: { list: [T.allowanceModule], next: OTHER_MODULE } })).toEqual(otherModule);
    expect(read({ ...HEALTHY, modules: { list: [T.allowanceModule], next: zeroAddress } })).toEqual(otherModule);
    // Another add-on alone could move the money: never "stopped", even with no delegate.
    expect(read({ ...REAL_STOPPED, modules: { list: [OTHER_MODULE], next: SAFE_SENTINEL } })).toEqual(
      limitsNotRead("other_module", BigInt(0)),
    );
    expect(read({ ...REAL_STOPPED, modules: { list: [], next: OTHER_MODULE } })).toEqual(
      limitsNotRead("other_module", BigInt(0)),
    );
  });

  // Rules 4 and 5.
  test("a guard: guard_set; a fallback handler other than Safe's: other_handler", () => {
    expect(read({ ...HEALTHY, guard: OTHER })).toEqual(limitsNotRead("guard_set"));
    expect(read({ ...REAL_STOPPED, guard: OTHER })).toEqual(limitsNotRead("guard_set", BigInt(0)));
    expect(read({ ...HEALTHY, fallbackHandler: OTHER })).toEqual(limitsNotRead("other_handler"));
    expect(read({ ...HEALTHY, fallbackHandler: zeroAddress })).toEqual(limitsNotRead("other_handler"));
    expect(read({ ...REAL_STOPPED, fallbackHandler: OTHER })).toEqual(limitsNotRead("other_handler", BigInt(0)));
  });

  // Rule 6.
  test("an ERC-20 allowance of 1 unit from the pot to the agent's key: usdc_approved, on a healthy pot and on a stopped one", () => {
    expect(read({ ...HEALTHY, usdcAllowanceToAgent: BigInt(1) })).toEqual(limitsNotRead("usdc_approved"));
    expect(read({ ...REAL_STOPPED, usdcAllowanceToAgent: BigInt(1) })).toEqual(
      limitsNotRead("usdc_approved", BigInt(0)),
    );
    // A stop by removeDelegate is no stop either while the key holds an approval.
    expect(
      read({ ...HEALTHY, delegates: { list: [], next: 0 }, usdcAllowanceToAgent: BigInt(1) }),
    ).toEqual(limitsNotRead("usdc_approved"));
  });

  // Rule 7.
  test("after disableModule the module still answers [50000000, 5000000, 43200, ...] and the reading is stopped, module_off", () => {
    const disabled: PotRaw = {
      ...HEALTHY,
      modules: { list: [], next: SAFE_SENTINEL },
      allowance: [BigInt(50_000_000), BigInt(5_000_000), BigInt(43200), BigInt(29919864), BigInt(3)],
    };
    expect(read(disabled)).toEqual({ state: "stopped", why: "module_off", balanceUnits: HEALTHY.balanceUnits });
    // Whatever the module still says of its delegates and tokens.
    expect(read({ ...disabled, delegates: { list: [X, A], next: 7 }, tokens: [zeroAddress] })).toEqual({
      state: "stopped",
      why: "module_off",
      balanceUnits: HEALTHY.balanceUnits,
    });
  });

  // Rule 8.
  test("after removeDelegate the token is still listed and the reading is stopped, no_delegate", () => {
    const removed: PotRaw = {
      ...HEALTHY,
      delegates: { list: [], next: 0 },
      tokens: [T.usdc],
      allowance: [BigInt(0), BigInt(0), BigInt(0), BigInt(0), BigInt(2)],
    };
    expect(read(removed)).toEqual({ state: "stopped", why: "no_delegate", balanceUnits: HEALTHY.balanceUnits });
  });

  test("an empty delegates page that says more follow is never stopped: other_delegate", () => {
    // The pinned module cannot answer this; the rule refuses it all the same.
    expect(read({ ...HEALTHY, delegates: { list: [], next: 3 } })).toEqual(limitsNotRead("other_delegate"));
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
    const lowerG = G.toLowerCase() as Address;
    expect(potReading(guardianAsAgent, { ...EXPECT, agentWallet: lowerG })).toEqual(
      limitsNotRead("other_delegate"),
    );
    expect(
      potReading({ ...HEALTHY, owners: [lowerG], delegates: { list: [lowerG], next: 0 } }, { ...EXPECT, agentWallet: G }),
    ).toEqual(limitsNotRead("other_delegate"));
    expect(
      potReading(guardianAsAgent, { ...EXPECT, guardian: `0x${G.slice(2).toUpperCase()}` as Address, agentWallet: lowerG }),
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
      allowance: [BigInt(2_000_000), BigInt(1_000_000), BigInt(5), BigInt(29923000), BigInt(2)],
    };
    expect(read(five)).toEqual(limitsNotRead("other_period"));
    // A delegate whose allowance was zeroed has no period: nothing is read either.
    expect(
      read({ ...HEALTHY, allowance: [BigInt(0), BigInt(0), BigInt(0), BigInt(0), BigInt(3)] }),
    ).toEqual(limitsNotRead("other_period"));
    expect(
      read({ ...HEALTHY, allowance: [HEALTHY.allowance[0], HEALTHY.allowance[1], BigInt(43201), HEALTHY.allowance[3], HEALTHY.allowance[4]] }),
    ).toEqual(limitsNotRead("other_period"));
  });

  // Rule 12.
  test("a ceiling of 0 is still ceiling_read, with 0", () => {
    const zero: PotRaw = {
      ...HEALTHY,
      allowance: [BigInt(0), BigInt(0), BigInt(43200), BigInt(29919864), BigInt(1)],
    };
    expect(read(zero)).toEqual({
      state: "ceiling_read",
      ceilingUnits: BigInt(0),
      spentUnits: BigInt(0),
      periodEndsAt: (29919864 + 43200) * 60,
      nonce: BigInt(1),
      balanceUnits: HEALTHY.balanceUnits,
    });
  });

  test("the first rule that applies decides", () => {
    // Rule 2 before rule 3: a Safe that is not the guardian's alone reads nothing, never a problem.
    expect(read({ ...HEALTHY, owners: [X], modules: { list: [OTHER_MODULE], next: SAFE_SENTINEL } })).toEqual({
      state: "not_the_guardians",
    });
    // Rule 3 before rule 4, 4 before 5, 5 before 6.
    expect(read({ ...HEALTHY, modules: { list: [OTHER_MODULE], next: SAFE_SENTINEL }, guard: OTHER })).toEqual(
      limitsNotRead("other_module"),
    );
    expect(read({ ...HEALTHY, guard: OTHER, fallbackHandler: OTHER })).toEqual(limitsNotRead("guard_set"));
    expect(read({ ...HEALTHY, fallbackHandler: OTHER, usdcAllowanceToAgent: BigInt(5) })).toEqual(
      limitsNotRead("other_handler"),
    );
    // Rules 3 to 6 before 7 and 8: "stopped" only when nothing else could take.
    expect(read({ ...REAL_STOPPED, guard: OTHER, usdcAllowanceToAgent: BigInt(1) })).toEqual(
      limitsNotRead("guard_set", BigInt(0)),
    );
    // Rule 7 before 8, 8 before 9, 9 before 10, 10 before 11.
    expect(read({ ...HEALTHY, modules: { list: [], next: SAFE_SENTINEL }, delegates: { list: [], next: 0 } })).toEqual({
      state: "stopped",
      why: "module_off",
      balanceUnits: HEALTHY.balanceUnits,
    });
    expect(read({ ...HEALTHY, delegates: { list: [], next: 0 }, tokens: [zeroAddress] })).toEqual({
      state: "stopped",
      why: "no_delegate",
      balanceUnits: HEALTHY.balanceUnits,
    });
    expect(read({ ...HEALTHY, delegates: { list: [X], next: 0 }, tokens: [zeroAddress] })).toEqual(
      limitsNotRead("other_delegate"),
    );
    expect(
      read({
        ...HEALTHY,
        tokens: [zeroAddress],
        allowance: [BigInt(1), BigInt(0), BigInt(5), BigInt(0), BigInt(0)],
      }),
    ).toEqual(limitsNotRead("other_token"));
  });

  test("a value of the wrong kind never reads as a pass", () => {
    // What a typed caller cannot hand in, but a fail-closed reading still refuses.
    const asRaw = (r: unknown) => r as PotRaw;
    expect(read(asRaw({ ...HEALTHY, threshold: 1 }))).toEqual({ state: "not_the_guardians" });
    expect(read(asRaw({ ...HEALTHY, codeHash: undefined }))).toEqual({ state: "not_the_guardians" });
    expect(read(asRaw({ ...HEALTHY, usdcAllowanceToAgent: 0 }))).toEqual(limitsNotRead("usdc_approved"));
    expect(read(asRaw({ ...HEALTHY, delegates: { list: [A], next: BigInt(0) } }))).toEqual(
      limitsNotRead("other_delegate"),
    );
    expect(
      read(asRaw({ ...HEALTHY, allowance: [BigInt(1), BigInt(0), 43200, BigInt(1), BigInt(1)] })),
    ).toEqual(limitsNotRead("other_period"));
    // Rule 12 reads the allowance's five facts as bigints, or reads no ceiling.
    const [amount, spent, resetTimeMin, lastResetMin, nonce] = HEALTHY.allowance;
    expect(read(asRaw({ ...HEALTHY, allowance: [50_000_000, spent, resetTimeMin, lastResetMin, nonce] }))).toEqual(
      limitsNotRead("other_period"),
    );
    expect(read(asRaw({ ...HEALTHY, allowance: [amount, spent, resetTimeMin, 29919864, nonce] }))).toEqual(
      limitsNotRead("other_period"),
    );
    expect(read(asRaw({ ...HEALTHY, allowance: [amount, 10_000_000, resetTimeMin, lastResetMin, nonce] }))).toEqual(
      limitsNotRead("other_period"),
    );
    expect(read(asRaw({ ...HEALTHY, allowance: [amount, spent, resetTimeMin, lastResetMin, 2] }))).toEqual(
      limitsNotRead("other_period"),
    );
    expect(read(asRaw({ ...HEALTHY, allowance: [amount, spent, resetTimeMin, lastResetMin] }))).toEqual(
      limitsNotRead("other_period"),
    );
    // An empty string is not an empty list: never "stopped".
    expect(read(asRaw({ ...HEALTHY, modules: { list: "", next: SAFE_SENTINEL } }))).toEqual(
      limitsNotRead("other_module"),
    );
    expect(read(asRaw({ ...HEALTHY, delegates: { list: "", next: 0 } }))).toEqual(limitsNotRead("other_delegate"));
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
  test("potCeilingCapFromGrant: null is none; buy 100 and pay 250 allowed, contractor not, is capped 350 with its end day; none allowed is no_spending", () => {
    expect(potCeilingCapFromGrant(null)).toEqual({ kind: "none" });
    expect(
      potCeilingCapFromGrant(grant({ buy: spend(100, 40), pay: spend(250, 250), engageContractor: NO }, "2027-01-31")),
    ).toEqual({ kind: "capped", maxUsdc: 350, endsOn: "2027-01-31" });
    expect(potCeilingCapFromGrant(grant({ buy: NO, pay: NO, engageContractor: NO }))).toEqual({
      kind: "no_spending",
    });
    expect(potCeilingCapFromGrant(grant({ buy: NO, pay: NO, engageContractor: NO }, "2027-01-31"))).toEqual({
      kind: "no_spending",
    });
  });

  test("each kind alone, and the three at the grant's largest amount reach the field's own maximum", () => {
    expect(potCeilingCapFromGrant(grant({ buy: NO, pay: NO, engageContractor: spend(75) }))).toEqual({
      kind: "capped",
      maxUsdc: 75,
      endsOn: null,
    });
    expect(potCeilingCapFromGrant(grant({ buy: spend(1), pay: NO, engageContractor: NO }))).toEqual({
      kind: "capped",
      maxUsdc: 1,
      endsOn: null,
    });
    const max = 1_000_000_000;
    expect(
      potCeilingCapFromGrant(grant({ buy: spend(max), pay: spend(max), engageContractor: spend(max) })),
    ).toEqual({ kind: "capped", maxUsdc: POT_CEILING_MAX_USDC, endsOn: null });
  });

  test("the amount per act is not the cap: the thirty-day amounts are", () => {
    expect(
      potCeilingCapFromGrant(grant({ buy: spend(500, 10), pay: spend(20, 20), engageContractor: NO })),
    ).toEqual({ kind: "capped", maxUsdc: 520, endsOn: null });
  });

  test("a setting that is not a whole thirty-day amount from 1 to 1,000,000,000 adds nothing, never more", () => {
    const odd = (s: unknown) => s as GrantSpend;
    const pay = spend(250);
    const cases: unknown[] = [
      { allowed: true, perAct: 1, per30Days: "100", above: "guardian_signature" },
      { allowed: true, perAct: 1, per30Days: Number.NaN, above: "guardian_signature" },
      { allowed: true, perAct: 1, per30Days: Number.POSITIVE_INFINITY, above: "guardian_signature" },
      { allowed: true, perAct: 1, per30Days: 0, above: "guardian_signature" },
      { allowed: true, perAct: 1, per30Days: -100, above: "guardian_signature" },
      { allowed: true, perAct: 1, per30Days: 1.5, above: "guardian_signature" },
      { allowed: true, perAct: 1, per30Days: 1_000_000_001, above: "guardian_signature" },
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
    for (const g of [{}, { choices: null }, { choices: {} }, { choices: { acts: null, endsOn: null } }, { choices: { endsOn: "2027-01-31" } }, "grant", 7])
      expect(potCeilingCapFromGrant(broken(g))).toEqual({ kind: "none" });
    expect(potCeilingCapFromGrant(broken(undefined))).toEqual({ kind: "none" });
    // Nothing left that allows spending: no spending.
    expect(potCeilingCapFromGrant(grant({ buy: odd(cases[0]), pay: NO, engageContractor: NO }))).toEqual({
      kind: "no_spending",
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The browser's read
// ---------------------------------------------------------------------------------------------

/** The real Safe's runtime code (171 bytes), read with `cast code` at block 73,886,273. */
const REAL_PROXY_CODE: Hex =
  "0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033";
const REAL_BLOCK = BigInt(73_886_273);
const WORD_ZERO: Hex = `0x${"0".repeat(64)}`;
/** What the real Safe answered for its fallback handler slot on 24 Nov: lower case, 32 bytes. */
const REAL_HANDLER_WORD: Hex = "0x000000000000000000000000fd0732dc9e303f09fcef3a7388ad10a83459ec99";

type Contract = { address: Address; abi: unknown; functionName: string; args?: readonly unknown[] };

/** The real Safe's answers at block 73,886,273, per function (and slot). */
function realAnswer(c: Contract): unknown {
  switch (c.functionName) {
    case "masterCopy":
      return "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
    case "getOwners":
      return [G];
    case "getThreshold":
      return BigInt(1);
    case "getModulesPaginated":
      return [[], SAFE_SENTINEL];
    case "getStorageAt":
      return c.args?.[0] === BigInt(SAFE_GUARD_SLOT) ? WORD_ZERO : REAL_HANDLER_WORD;
    case "getDelegates":
      return [[], 0];
    case "getTokens":
      return ["0x3600000000000000000000000000000000000000"];
    case "getTokenAllowance":
      return [BigInt(0), BigInt(0), BigInt(0), BigInt(0), BigInt(3)];
    case "balanceOf":
      return BigInt(0);
    case "allowance":
      return BigInt(0);
    default:
      throw new Error(`no answer for ${c.functionName}`);
  }
}

/** A hand-made client: the real Safe's answers, each read recorded; `answer` can be replaced. */
function fakeClient(over: {
  potCode?: Hex | undefined;
  agentCode?: Hex | undefined;
  answer?: (c: Contract) => unknown;
  reject?: "getBlockNumber" | "getCode" | "getBalance" | "multicall";
} = {}) {
  const potCode = "potCode" in over ? over.potCode : REAL_PROXY_CODE;
  const agentCode = "agentCode" in over ? over.agentCode : undefined;
  const answer = over.answer ?? realAnswer;
  const fail = (name: string) => over.reject === name;
  const client = {
    // The options are recorded by the spy: the test pins `cacheTime: 0`.
    getBlockNumber: vi.fn(async (options?: { cacheTime?: number }) => {
      void options;
      if (fail("getBlockNumber")) throw new Error("no head");
      return REAL_BLOCK;
    }),
    getCode: vi.fn(async (p: { address: Address; blockNumber?: bigint }) => {
      if (fail("getCode")) throw new Error("no code read");
      return p.address.toLowerCase() === SAFE_CREATED.toLowerCase() ? potCode : agentCode;
    }),
    getBalance: vi.fn(async (p: { address: Address; blockNumber?: bigint }) => {
      if (fail("getBalance")) throw new Error("no balance read");
      return p.address.toLowerCase() === SAFE_CREATED.toLowerCase() ? BigInt(0) : REAL_AGENT_WEI;
    }),
    multicall: vi.fn(async (p: { contracts: readonly Contract[]; allowFailure: false; multicallAddress: Address; blockNumber?: bigint }) => {
      // As viem's own multicall does: each call encoded against its fragment, each address
      // checked (a mixed case that is not the checksum is refused).
      if (!isAddress(p.multicallAddress)) throw new Error("bad multicall address");
      for (const c of p.contracts) {
        if (!isAddress(c.address)) throw new Error("bad target");
        encodeFunctionData(c as Parameters<typeof encodeFunctionData>[0]);
      }
      if (fail("multicall")) throw new Error("a call reverted");
      return p.contracts.map(answer);
    }),
  };
  return { client, port: client as unknown as PublicClient };
}

const WHERE = { pot: SAFE_CREATED, agentWallet: A };

/** A PotRaw of a pot that has no proxy's code: only the code hash says anything. */
const EMPTY_REST = {
  singleton: zeroAddress,
  owners: [],
  threshold: BigInt(0),
  modules: { list: [], next: zeroAddress },
  guard: zeroAddress,
  fallbackHandler: zeroAddress,
  delegates: { list: [], next: 0 },
  tokens: [],
  allowance: [BigInt(0), BigInt(0), BigInt(0), BigInt(0), BigInt(0)],
  usdcAllowanceToAgent: BigInt(0),
  balanceUnits: BigInt(0),
  balanceWei: BigInt(0),
  agentBalanceWei: BigInt(0),
  agentHasCode: false,
};

describe("readPotRaw: the browser's read of a pot, at one block", () => {
  test("the real Safe reads as it stands, and its reading is stopped, module_off", async () => {
    const { client, port } = fakeClient();
    const raw = await readPotRaw(port, T, WHERE);
    expect(raw).toEqual({
      codeHash: SAFE_PROXY_RUNTIME_CODE_HASH,
      singleton: T.safeSingleton,
      owners: [G],
      threshold: BigInt(1),
      modules: { list: [], next: SAFE_SENTINEL },
      guard: zeroAddress,
      fallbackHandler: T.fallbackHandler,
      delegates: { list: [], next: 0 },
      tokens: [T.usdc],
      allowance: [BigInt(0), BigInt(0), BigInt(0), BigInt(0), BigInt(3)],
      usdcAllowanceToAgent: BigInt(0),
      balanceUnits: BigInt(0),
      balanceWei: BigInt(0),
      agentBalanceWei: REAL_AGENT_WEI,
      agentHasCode: false,
    });
    expect(raw).toEqual(REAL_STOPPED);
    expect(potReading(raw, EXPECT)).toEqual({ state: "stopped", why: "module_off", balanceUnits: BigInt(0) });
    expect(client.getBlockNumber).toHaveBeenCalledTimes(1);
    // The head read fresh: viem otherwise serves a cached block number for its polling interval,
    // and a read right after the guardian's own transaction could see an older block.
    expect(client.getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 });
    expect(client.multicall).toHaveBeenCalledTimes(1);
    expect(client.getCode).toHaveBeenCalledTimes(2);
    expect(client.getBalance).toHaveBeenCalledTimes(2);
  });

  test("readPotRaw: every read carries the same block number; no code answers codeHash null and reads nothing else; a code that is not the proxy's reads nothing else; a rejected read rejects", async () => {
    // Every read at the block read first.
    const healthy = fakeClient();
    await readPotRaw(healthy.port, T, WHERE);
    const calls = [
      ...healthy.client.getCode.mock.calls,
      ...healthy.client.getBalance.mock.calls,
      ...healthy.client.multicall.mock.calls,
    ];
    expect(calls).toHaveLength(5);
    for (const [p] of calls) expect(p.blockNumber).toBe(REAL_BLOCK);

    // No code: null, and nothing else read.
    for (const potCode of [undefined, "0x" as Hex]) {
      const none = fakeClient({ potCode });
      expect(await readPotRaw(none.port, T, WHERE)).toEqual({ codeHash: null, ...EMPTY_REST });
      expect(none.client.getCode).toHaveBeenCalledTimes(1);
      expect(none.client.getCode.mock.calls[0][0]).toEqual({ address: SAFE_CREATED, blockNumber: REAL_BLOCK });
      expect(none.client.multicall).not.toHaveBeenCalled();
      expect(none.client.getBalance).not.toHaveBeenCalled();
    }

    // A code that is not the proxy's: its hash, and nothing else read.
    const other = fakeClient({ potCode: "0x6000" });
    const otherRaw = await readPotRaw(other.port, T, WHERE);
    expect(otherRaw).toEqual({ codeHash: keccak256("0x6000"), ...EMPTY_REST });
    expect(potReading(otherRaw, EXPECT)).toEqual({ state: "not_the_guardians" });
    expect(other.client.getCode).toHaveBeenCalledTimes(1);
    expect(other.client.multicall).not.toHaveBeenCalled();
    expect(other.client.getBalance).not.toHaveBeenCalled();

    // A rejected read rejects: a failure is never an answer.
    for (const reject of ["getBlockNumber", "getCode", "getBalance", "multicall"] as const) {
      const failing = fakeClient({ reject });
      await expect(readPotRaw(failing.port, T, WHERE)).rejects.toThrow();
    }
  });

  test("one multicall through Multicall3, failures not allowed, with the reads the real run made", async () => {
    const { client, port } = fakeClient();
    await readPotRaw(port, T, WHERE);
    const p = client.multicall.mock.calls[0][0];
    expect(p.multicallAddress).toBe(T.multicall3);
    expect(p.allowFailure).toBe(false);
    const asked = p.contracts.map((c) => ({ address: c.address, functionName: c.functionName, args: c.args ?? [] }));
    expect(asked).toEqual([
      { address: SAFE_CREATED, functionName: "masterCopy", args: [] },
      { address: SAFE_CREATED, functionName: "getOwners", args: [] },
      { address: SAFE_CREATED, functionName: "getThreshold", args: [] },
      { address: SAFE_CREATED, functionName: "getModulesPaginated", args: [SAFE_SENTINEL, BigInt(10)] },
      { address: SAFE_CREATED, functionName: "getStorageAt", args: [BigInt(SAFE_GUARD_SLOT), BigInt(1)] },
      { address: SAFE_CREATED, functionName: "getStorageAt", args: [BigInt(SAFE_FALLBACK_HANDLER_SLOT), BigInt(1)] },
      { address: T.allowanceModule, functionName: "getDelegates", args: [SAFE_CREATED, 0, 10] },
      { address: T.allowanceModule, functionName: "getTokens", args: [SAFE_CREATED, A] },
      { address: T.allowanceModule, functionName: "getTokenAllowance", args: [SAFE_CREATED, A, T.usdc] },
      { address: T.usdc, functionName: "balanceOf", args: [SAFE_CREATED] },
      { address: T.usdc, functionName: "allowance", args: [SAFE_CREATED, A] },
    ]);
    // Each against its pinned fragment.
    for (const c of p.contracts.slice(0, 6)) expect(c.abi).toBe(safeAbi);
    for (const c of p.contracts.slice(6, 9)) expect(c.abi).toBe(allowanceModuleAbi);
    for (const c of p.contracts.slice(9)) expect(c.abi).toBe(erc20Abi);
    // The balances and the agent's code, of the pot and the agent's wallet.
    expect(client.getBalance.mock.calls.map(([q]) => q.address)).toEqual([SAFE_CREATED, A]);
    expect(client.getCode.mock.calls.map(([q]) => q.address)).toEqual([SAFE_CREATED, A]);
  });

  test("a healthy pot's answers read back into the fixture, and a delegated key's code reads as code", async () => {
    const healthyAnswer = (c: Contract): unknown => {
      switch (c.functionName) {
        case "getModulesPaginated":
          return [[T.allowanceModule], SAFE_SENTINEL];
        case "getDelegates":
          return [[A], 0];
        case "getTokenAllowance":
          return HEALTHY.allowance;
        case "balanceOf":
          return HEALTHY.balanceUnits;
        default:
          return realAnswer(c);
      }
    };
    const { port } = fakeClient({ answer: healthyAnswer, agentCode: "0xef01002ddcf8da463526614b9fa5e87db259a3bf06667c" });
    const raw = await readPotRaw(port, T, WHERE);
    expect(raw.modules).toEqual(HEALTHY.modules);
    expect(raw.delegates).toEqual(HEALTHY.delegates);
    expect(raw.allowance).toEqual(HEALTHY.allowance);
    expect(raw.agentHasCode).toBe(true);
    expect(potReading({ ...raw, balanceWei: HEALTHY.balanceWei }, EXPECT)).toEqual(read(HEALTHY));
  });

  test("addresses in any letter case: the reads send them checksummed and read the same", async () => {
    const { client, port } = fakeClient();
    const upper = (x: Address) => `0x${x.slice(2).toUpperCase()}` as Address;
    const lowerAddresses = Object.fromEntries(
      Object.entries(T).map(([k, v]) => [k, v.toLowerCase()]),
    ) as PotAddresses;
    const raw = await readPotRaw(port, lowerAddresses, {
      pot: SAFE_CREATED.toLowerCase() as Address,
      agentWallet: upper(A),
    });
    expect(raw).toEqual(REAL_STOPPED);
    const p = client.multicall.mock.calls[0][0];
    expect(p.multicallAddress).toBe(T.multicall3);
    expect(p.contracts.map((c) => c.address)).toEqual([
      ...Array(6).fill(SAFE_CREATED),
      ...Array(3).fill(T.allowanceModule),
      T.usdc,
      T.usdc,
    ]);
    expect(p.contracts[7].args).toEqual([SAFE_CREATED, A]);
    expect(p.contracts[8].args).toEqual([SAFE_CREATED, A, T.usdc]);
    expect(client.getCode.mock.calls.map(([q]) => q.address)).toEqual([SAFE_CREATED, A]);
    expect(client.getBalance.mock.calls.map(([q]) => q.address)).toEqual([SAFE_CREATED, A]);
  });

  test("the guard and the handler are the last 20 bytes of their 32-byte words; any other word rejects", async () => {
    const withWords = (guard: Hex, handler: Hex) => (c: Contract) =>
      c.functionName === "getStorageAt"
        ? c.args?.[0] === BigInt(SAFE_GUARD_SLOT)
          ? guard
          : handler
        : realAnswer(c);
    const guardWord: Hex = `0x${"0".repeat(24)}${OTHER.slice(2)}`;
    const set = await readPotRaw(fakeClient({ answer: withWords(guardWord, REAL_HANDLER_WORD) }).port, T, WHERE);
    expect(set.guard.toLowerCase()).toBe(OTHER);
    expect(potReading(set, EXPECT)).toEqual(limitsNotRead("guard_set", BigInt(0)));

    // Not 32 bytes, or a word with something above its last 20 bytes: not an address.
    const bad: Hex[] = ["0x", `0x${"0".repeat(62)}`, `0x${"0".repeat(66)}`, `0x01${"0".repeat(22)}${OTHER.slice(2)}`];
    for (const word of bad) {
      await expect(
        readPotRaw(fakeClient({ answer: withWords(word, REAL_HANDLER_WORD) }).port, T, WHERE),
      ).rejects.toThrow();
      await expect(readPotRaw(fakeClient({ answer: withWords(WORD_ZERO, word) }).port, T, WHERE)).rejects.toThrow();
    }
  });
});
