/**
 * The company's pot, as read: when the record and the screens may say "the agent's key may take
 * up to X in each thirty-day period", when "no key may take from it", when "its limits were not
 * read", and when nothing at all.
 *
 * Here: the reading rules (`potReading`), each pure; the browser's read of a pot's raw facts from
 * the chain, all at one block (`readPotRaw`), through a client handed in; and the most the ceiling
 * field takes, from the agent's grant (`potCeilingCapFromGrant`).
 *
 * The rules fail closed: a fact that is not exactly the expected one never reads as a pass, and
 * "stopped" or a ceiling is said only once every add-on that could move the pot's money has been
 * ruled out. The module's own answers are never enough on their own: the Safe's module list is
 * always read with them (RESULTS.md, S6). The server holds a copy of these rules, the same list
 * word for word.
 *
 * Nothing here reads a clock or holds a key. Addresses are compared without regard to letter case,
 * and hex in lower case.
 */
import { getAddress, keccak256, zeroAddress, type PublicClient } from "viem";
import type { Address, Hex } from "@/lib/api/types";
import { sameAddress } from "./flow";
import {
  allowanceModuleAbi,
  erc20Abi,
  POT_PERIOD_MINUTES,
  SAFE_FALLBACK_HANDLER_SLOT,
  SAFE_GUARD_SLOT,
  SAFE_PROXY_RUNTIME_CODE_HASH,
  SAFE_SENTINEL,
  safeAbi,
  type PotAddresses,
} from "./safePot";

const ZERO = BigInt(0);
const ONE = BigInt(1);
const PERIOD = BigInt(POT_PERIOD_MINUTES);
const SECONDS_PER_MINUTE = BigInt(60);

// ---------------------------------------------------------------------------------------------
// The reading rules
// ---------------------------------------------------------------------------------------------

/** What one block answered. `codeHash` is keccak256 of the code at the address, null for no code. */
export type PotRaw = {
  codeHash: Hex | null;
  singleton: Address;
  owners: readonly Address[];
  threshold: bigint;
  modules: { list: readonly Address[]; next: Address };
  guard: Address;
  fallbackHandler: Address;
  delegates: { list: readonly Address[]; next: number };
  tokens: readonly Address[];
  /** getTokenAllowance: amount, spent, resetTimeMin, lastResetMin, nonce. */
  allowance: readonly [bigint, bigint, bigint, bigint, bigint];
  /** The token's allowance(pot, agentWallet): an ERC-20 approval from the pot to the agent's key. */
  usdcAllowanceToAgent: bigint;
  /** The token's balanceOf(pot). */
  balanceUnits: bigint;
  /** The native balance of the pot. */
  balanceWei: bigint;
  /** The native balance of the agent's wallet: its fee money. */
  agentBalanceWei: bigint;
  /** The agent's wallet holds code (a contract or a delegated key). */
  agentHasCode: boolean;
};

/** Why a pot of the guardian's alone has limits that were not read. */
export type PotLimitsProblem =
  | "other_module"
  | "guard_set"
  | "other_handler"
  | "usdc_approved"
  | "other_delegate"
  | "other_token"
  | "other_period";

/**
 * absent: no code at the address. not_the_guardians: code that is not a pot of the guardian's
 * alone; the screens say nothing of it. stopped: no key may take from it. limits_not_read: a pot
 * of the guardian's alone with something the rules do not read past. ceiling_read: the agent's key
 * may take up to `ceilingUnits` in each thirty-day period; `spentUnits` were taken in the current
 * one, which ends at `periodEndsAt` (unix seconds).
 */
export type PotReading =
  | { state: "absent" }
  | { state: "not_the_guardians" }
  | { state: "stopped"; why: "module_off" | "no_delegate"; balanceUnits: bigint }
  | { state: "limits_not_read"; problem: PotLimitsProblem; balanceUnits: bigint }
  | {
      state: "ceiling_read";
      ceilingUnits: bigint;
      spentUnits: bigint;
      periodEndsAt: number;
      nonce: bigint;
      balanceUnits: bigint;
    };

/** A real list holding nothing: anything that is not an array is never empty. */
const isEmptyList = (list: unknown): boolean => Array.isArray(list) && list.length === 0;

/** A real list holding exactly `one`, in any letter case. */
const isExactly = (list: unknown, one: Address): boolean =>
  Array.isArray(list) && list.length === 1 && sameAddress(list[0], one);

/** Hex compared in lower case; anything that is not a string is never equal. */
const sameHex = (a: unknown, b: Hex): boolean =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * What a pot's raw facts let the record say. The rules, in this order, the first that applies
 * decides:
 *
 *  1. `codeHash` null: `absent`.
 *  2. `codeHash` is not `SAFE_PROXY_RUNTIME_CODE_HASH`, or `singleton` is not
 *     `addresses.safeSingleton`, or `owners` is not exactly `[guardian]`, or `threshold` is not 1:
 *     `not_the_guardians`.
 *  3. `modules.list` is neither empty nor exactly `[addresses.allowanceModule]`, or `modules.next`
 *     is not the sentinel: `other_module` (another add-on alone counts here, never as "stopped":
 *     it could move the money).
 *  4. `guard` is not the zero address: `guard_set`.
 *  5. `fallbackHandler` is not `addresses.fallbackHandler`: `other_handler`.
 *  6. `usdcAllowanceToAgent` is not 0: `usdc_approved`.
 *  7. `modules.list` is empty: `stopped`, `why: "module_off"`.
 *  8. `delegates.list` is empty: `stopped`, `why: "no_delegate"`.
 *  9. `delegates.list` is not exactly `[agentWallet]`, or `delegates.next` is not 0:
 *     `other_delegate`.
 * 10. `tokens` is not exactly `[addresses.usdc]`: `other_token` (this closes an allowance on the
 *     native coin, token zero).
 * 11. `allowance[2]` is not 43200: `other_period`.
 * 12. Otherwise `ceiling_read`: `ceilingUnits = allowance[0]`, `spentUnits = allowance[1]`,
 *     `periodEndsAt = Number((allowance[3] + 43200) * 60)` in unix seconds,
 *     `nonce = allowance[4]`.
 *
 * The module's own answers are never enough: after `disableModule` it still returns the delegate
 * and a live-looking allowance, and after `removeDelegate` it still lists the token (both seen in
 * the proof). Rules 3 and 7 come before the module's answers are read for that reason. "Stopped"
 * is reached only after rules 3 to 6, so "no key may take from it" is said only when no other
 * add-on, guard, handler or approval could.
 *
 * Every rule asks for the expected fact and nothing else: a value of another kind (a number where
 * a bigint belongs, a string where a list belongs) breaks the rule it is read by, and only a pot
 * that passes rules 1 to 11 reads a ceiling.
 */
export function potReading(
  raw: PotRaw,
  expect: { addresses: PotAddresses; guardian: Address; agentWallet: Address },
): PotReading {
  const a = expect.addresses;
  // 1.
  if (raw.codeHash === null) return { state: "absent" };
  // 2.
  if (
    !sameHex(raw.codeHash, SAFE_PROXY_RUNTIME_CODE_HASH) ||
    !sameAddress(raw.singleton, a.safeSingleton) ||
    !isExactly(raw.owners, expect.guardian) ||
    raw.threshold !== ONE
  )
    return { state: "not_the_guardians" };

  const balanceUnits = raw.balanceUnits;
  const notRead = (problem: PotLimitsProblem): PotReading => ({
    state: "limits_not_read",
    problem,
    balanceUnits,
  });
  // 3.
  const moduleOff = isEmptyList(raw.modules.list);
  if (
    !(moduleOff || isExactly(raw.modules.list, a.allowanceModule)) ||
    !sameAddress(raw.modules.next, SAFE_SENTINEL)
  )
    return notRead("other_module");
  // 4.
  if (!sameAddress(raw.guard, zeroAddress)) return notRead("guard_set");
  // 5.
  if (!sameAddress(raw.fallbackHandler, a.fallbackHandler)) return notRead("other_handler");
  // 6.
  if (raw.usdcAllowanceToAgent !== ZERO) return notRead("usdc_approved");
  // 7.
  if (moduleOff) return { state: "stopped", why: "module_off", balanceUnits };
  // 8.
  if (isEmptyList(raw.delegates.list)) return { state: "stopped", why: "no_delegate", balanceUnits };
  // 9.
  if (!isExactly(raw.delegates.list, expect.agentWallet) || raw.delegates.next !== 0)
    return notRead("other_delegate");
  // 10.
  if (!isExactly(raw.tokens, a.usdc)) return notRead("other_token");
  // 11.
  const [amount, spent, resetTimeMin, lastResetMin, nonce] = raw.allowance;
  if (resetTimeMin !== PERIOD) return notRead("other_period");
  // 12.
  return {
    state: "ceiling_read",
    ceilingUnits: amount,
    spentUnits: spent,
    periodEndsAt: Number((lastResetMin + PERIOD) * SECONDS_PER_MINUTE),
    nonce,
    balanceUnits,
  };
}

// ---------------------------------------------------------------------------------------------
// The browser's read
// ---------------------------------------------------------------------------------------------

/** The first page of the Safe's module list, and of the module's delegates: ten, as the real run
 *  read them. A page that is not the end says so (`next`), and the rules refuse it. */
const PAGE = 10;
/** A storage word: 32 bytes, written out in full. */
const WORD = /^0x[0-9a-fA-F]{64}$/;
/** The 12 bytes above an address in a word: zeros. */
const ZERO_PREFIX = /^0{24}$/;

/** The address in a Safe's storage word, its last 20 bytes, checksummed. A word that is not 32
 *  bytes, or that holds anything above its last 20 bytes, is not an address: the read fails,
 *  never answers. */
function addressInWord(word: Hex, slot: string): Address {
  if (typeof word !== "string" || !WORD.test(word))
    throw new Error(`The pot's ${slot} slot did not answer one 32-byte word.`);
  if (!ZERO_PREFIX.test(word.slice(2, 26)))
    throw new Error(`The pot's ${slot} slot does not hold an address.`);
  return getAddress(`0x${word.slice(26).toLowerCase()}`);
}

/** An address as the reads send it: checksummed from lower case, so any letter case is taken
 *  (viem refuses a mixed case that is not the checksum when it encodes a call). */
const checksummed = (x: Address): Address => getAddress(x.toLowerCase());

/** viem's getCode answers undefined for no code; a node may answer `0x`. */
const hasCode = (code: Hex | undefined): code is Hex => code !== undefined && code !== "0x";

/** The facts of an address with no pot's code: empty lists, the zero address, zeros and false. */
const nothingElse = (codeHash: Hex | null): PotRaw => ({
  codeHash,
  singleton: zeroAddress,
  owners: [],
  threshold: ZERO,
  modules: { list: [], next: zeroAddress },
  guard: zeroAddress,
  fallbackHandler: zeroAddress,
  delegates: { list: [], next: 0 },
  tokens: [],
  allowance: [ZERO, ZERO, ZERO, ZERO, ZERO],
  usdcAllowanceToAgent: ZERO,
  balanceUnits: ZERO,
  balanceWei: ZERO,
  agentBalanceWei: ZERO,
  agentHasCode: false,
});

/**
 * The reads, all at one block number read first: `getCode(pot)`; then, only when its hash is the
 * proxy's, one `client.multicall` with `multicallAddress: a.multicall3` and `allowFailure: false`,
 * plus `getBalance` of the pot and of the agent's wallet and `getCode` of the agent's wallet. No
 * code: `codeHash: null`; a code hash that is not the proxy's: that hash; in both cases no other
 * read, and the other fields hold empty lists, the zero address, zeros and false. Any failed read
 * throws: a failure is never an answer.
 *
 * The multicall reads, as the real run read them: the Safe's `masterCopy()` (the proxy answers it
 * itself), `getOwners()`, `getThreshold()`, `getModulesPaginated(sentinel, 10)`, and its guard and
 * fallback handler slots by `getStorageAt(slot, 1)`; the module's `getDelegates(pot, 0, 10)`,
 * `getTokens(pot, agentWallet)` and `getTokenAllowance(pot, agentWallet, usdc)`; the token's
 * `balanceOf(pot)` and `allowance(pot, agentWallet)`. A code hash is keccak256 of `eth_getCode`:
 * Arc's nodes refuse `eth_getProof`. Addresses are taken in any letter case and sent checksummed.
 */
export async function readPotRaw(
  client: PublicClient,
  a: PotAddresses,
  p: { pot: Address; agentWallet: Address },
): Promise<PotRaw> {
  const pot = checksummed(p.pot);
  const agentWallet = checksummed(p.agentWallet);
  const usdc = checksummed(a.usdc);
  const blockNumber = await client.getBlockNumber();
  const potCode = await client.getCode({ address: pot, blockNumber });
  if (!hasCode(potCode)) return nothingElse(null);
  const codeHash = keccak256(potCode);
  if (!sameHex(codeHash, SAFE_PROXY_RUNTIME_CODE_HASH)) return nothingElse(codeHash);

  const safe = { address: pot, abi: safeAbi } as const;
  const allowances = { address: checksummed(a.allowanceModule), abi: allowanceModuleAbi } as const;
  const token = { address: usdc, abi: erc20Abi } as const;
  const [answers, balanceWei, agentBalanceWei, agentCode] = await Promise.all([
    client.multicall({
      contracts: [
        { ...safe, functionName: "masterCopy" },
        { ...safe, functionName: "getOwners" },
        { ...safe, functionName: "getThreshold" },
        { ...safe, functionName: "getModulesPaginated", args: [SAFE_SENTINEL, BigInt(PAGE)] },
        { ...safe, functionName: "getStorageAt", args: [BigInt(SAFE_GUARD_SLOT), ONE] },
        { ...safe, functionName: "getStorageAt", args: [BigInt(SAFE_FALLBACK_HANDLER_SLOT), ONE] },
        { ...allowances, functionName: "getDelegates", args: [pot, 0, PAGE] },
        { ...allowances, functionName: "getTokens", args: [pot, agentWallet] },
        { ...allowances, functionName: "getTokenAllowance", args: [pot, agentWallet, usdc] },
        { ...token, functionName: "balanceOf", args: [pot] },
        { ...token, functionName: "allowance", args: [pot, agentWallet] },
      ],
      multicallAddress: checksummed(a.multicall3),
      allowFailure: false,
      blockNumber,
    }),
    client.getBalance({ address: pot, blockNumber }),
    client.getBalance({ address: agentWallet, blockNumber }),
    client.getCode({ address: agentWallet, blockNumber }),
  ]);
  const [
    singleton,
    owners,
    threshold,
    [moduleList, moduleNext],
    guardWord,
    handlerWord,
    [delegateList, delegateNext],
    tokens,
    allowance,
    balanceUnits,
    usdcAllowanceToAgent,
  ] = answers;
  return {
    codeHash,
    singleton,
    owners,
    threshold,
    modules: { list: moduleList, next: moduleNext },
    guard: addressInWord(guardWord, "guard"),
    fallbackHandler: addressInWord(handlerWord, "fallback handler"),
    delegates: { list: delegateList, next: delegateNext },
    tokens,
    allowance,
    usdcAllowanceToAgent,
    balanceUnits,
    balanceWei,
    agentBalanceWei,
    agentHasCode: hasCode(agentCode),
  };
}

// ---------------------------------------------------------------------------------------------
// The ceiling's cap from a grant
// ---------------------------------------------------------------------------------------------

/** One of the grant's three spending kinds, as the order's grant door serves it: an amount per act
 *  and one per thirty days, in whole US dollars (one USDC counts as one US dollar). */
export type GrantSpend =
  | { allowed: false }
  | { allowed: true; perAct: number; per30Days: number; above: string };

export type PotCeilingCap =
  /** No grant: the guardian types the ceiling, up to POT_CEILING_MAX_USDC. */
  | { kind: "none" }
  /** A grant that allows none of the three kinds. */
  | { kind: "no_spending" }
  | { kind: "capped"; maxUsdc: number; endsOn: string | null };

/** The grant's largest amount, in whole US dollars (the server's GRANT_AMOUNT_MAX). */
const GRANT_AMOUNT_MAX = 1_000_000_000;

/** What one kind adds to the cap: its thirty-day amount when it is allowed, else nothing. A
 *  setting that is not exactly `allowed: true` with a whole `per30Days` from 1 to 1,000,000,000 (the
 *  server checks every grant so; anything else could only be a broken answer) adds nothing: a
 *  broken setting may lower the cap, never raise it. */
function per30DaysOf(setting: GrantSpend): number {
  if (typeof setting !== "object" || setting === null || setting.allowed !== true) return 0;
  const amount: unknown = setting.per30Days;
  return typeof amount === "number" &&
    Number.isSafeInteger(amount) &&
    amount >= 1 &&
    amount <= GRANT_AMOUNT_MAX
    ? amount
    : 0;
}

/**
 * The sum of `per30Days` of buy, pay and engageContractor where allowed: the most the field takes.
 * No grant is `none`; a grant whose three kinds add nothing is `no_spending`; otherwise `capped`,
 * with the grant's last day (`endsOn`, or null: until revoked). Three kinds at the grant's largest
 * amount add up to POT_CEILING_MAX_USDC, so a cap is never above the field's own maximum.
 */
export function potCeilingCapFromGrant(
  grant: {
    choices: {
      acts: { buy: GrantSpend; pay: GrantSpend; engageContractor: GrantSpend };
      endsOn: string | null;
    };
  } | null,
): PotCeilingCap {
  if (grant === null) return { kind: "none" };
  const { acts, endsOn } = grant.choices;
  const maxUsdc =
    per30DaysOf(acts.buy) + per30DaysOf(acts.pay) + per30DaysOf(acts.engageContractor);
  if (maxUsdc === 0) return { kind: "no_spending" };
  return { kind: "capped", maxUsdc, endsOn };
}
