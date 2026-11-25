/**
 * The company's pot, noted before the transaction: the guardian's wallet sends the pot's setup only
 * after the server has noted its address, and the server notes it only after recomputing it itself
 * from the birth details (the salt, the ceiling, the agent's key the registry names, the guardian),
 * with the guardian's declaration stored in the note and in the body's event log. One pot for life.
 * The guardian may take the pot off the public record at any time, with a note of its own: the pot
 * itself is untouched, and the address stays the body's. Beside a signed statement, the record
 * serves the pot on the record as read from the chain at the statement's own block, and a lookup by
 * any pot address a body declared leads to the body.
 *
 * The domain over a real in-memory database, a fake registry and a fake chain port, on a fixed
 * clock. Each body is placed through the order door's own domain function, so its agreement and
 * its grant read back as a real order's do; a body the statement service states is made by the
 * statement's fixtures, over a fake chain of statement snapshots. G, A and P are the real run's
 * public addresses, never a key; V3 is the pinned vector. Every other address is a placeholder.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Address, decodeFunctionData, getAddress, keccak256, size, zeroAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../src/errors";
import type { GrantChoices } from "../../src/legalBody/grant";
import {
  type LegalBodyPotDeps,
  POT_DECLARATION,
  declarePot,
  orderPot,
  potForAgent,
  potOfStatement,
  prepareTake,
  removePot,
  statementForPotAddress,
} from "../../src/legalBody/pot";
import {
  POT_CEILING_MAX_USDC,
  POT_FEE_LOW_WEI,
  type PotRaw,
  SAFE_PROXY_RUNTIME_CODE_HASH,
  SAFE_SENTINEL,
  allowanceModuleAbi,
  takeCalldata,
} from "../../src/legalBody/safePot";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { type StatementOutcome, statementForAgent } from "../../src/legalBody/statements";
import {
  type PotBirthNote,
  SqliteLegalBodyPotRepository,
} from "../../src/persistence/legalBodyPotRepository";
import type { LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import { CHAIN_ID, FACTORY } from "../helpers/customerCompanyFixtures";
import { A as GRANT_A } from "../helpers/grantFixtures";
import { customerCompany } from "../helpers/legalBodyFixtures";
import {
  CLOCK_S,
  FakeStatementChain,
  type StatementStores,
  openStatementStores,
  statementDeps,
} from "../helpers/legalBodyStatementFixtures";
import {
  A,
  BIRTH_V3,
  G,
  HEALTHY,
  NO_SPENDING,
  P,
  REAL_STOPPED,
  SOME_CODE,
  T,
  V3_ADDRESS,
  V3_INPUT,
  fakePotChain,
  fakeRegistry,
  inputFor,
  notePot,
  potAddressOf,
  potBody,
  potDeps,
  potOf,
  servedBirth,
  statedPotBody,
} from "../helpers/potFixtures";

/** The clock: 2026-11-24T12:00:00Z. */
const NOW_MS = Date.parse("2026-11-24T12:00:00.000Z");
const NOW_S = NOW_MS / 1000;
/** anvil's published account #2's address: another tenant, never a real wallet. */
const STRANGER: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

let s: StatementStores;
let pots: SqliteLegalBodyPotRepository;
let clock: number;
let registry: ReturnType<typeof fakeRegistry>;
let chain: ReturnType<typeof fakePotChain>;
let offered: boolean;
let printed: string[];

beforeEach(() => {
  // The legal-body stores and the statement log, over one new in-memory database.
  s = openStatementStores();
  pots = new SqliteLegalBodyPotRepository(s.db);
  clock = NOW_MS;
  registry = fakeRegistry();
  chain = fakePotChain();
  offered = true;
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  s.db.close();
});

const deps = (over: Partial<LegalBodyPotDeps> = {}): LegalBodyPotDeps => ({
  ...potDeps(s, {
    registry: { getAgentWallet: registry.getAgentWallet },
    chain: chain.port,
    now: () => clock,
    offered: () => offered,
  }),
  ...over,
});

/** A linked body of G (unless told otherwise) whose agent's wallet the registry names as `wallet`. */
function linked(
  o: { wallet?: Address; grant?: GrantChoices; tenant?: Address } = {},
): LegalBodyRecord {
  const row = potBody(s, { nowMs: clock, grant: o.grant, tenant: o.tenant });
  if (row.agentId === null) throw new Error("a linked body without its agent");
  registry.wallets.set(row.agentId, o.wallet ?? A);
  return row;
}

const declare = (row: LegalBodyRecord, input: unknown, tenant: Address = G) =>
  declarePot(deps(), tenant, row.legalBodyId, input);

/** The refusal `run` ended with. */
async function refusalOf(run: () => unknown): Promise<ApiError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("no refusal");
}

/**
 * A record written before Ruling R22: a declared note of `input`'s address and birth details,
 * written straight into the record, as the note door wrote a second address while the first held
 * no code. The door refuses that now (`pot_pending`); a body may still hold such a record, and
 * every rule after it still reads it.
 */
function noteBeforeR22(body: LegalBodyRecord, input: Record<string, string>): void {
  notePot(pots, body, {
    at: Math.floor(clock / 1000),
    address: input.address as Address,
    birth: {
      saltNonce: input.saltNonce as string,
      agentWallet: input.agentWallet as Address,
      ceilingUnits: input.ceilingUnits as string,
    },
  });
}

/** The refusal's code, status and sentence. */
const refused = (code: string, status: number) => ({
  code,
  status,
  message: LEGAL_BODY_SENTENCES[code],
});

const rows = () => s.db.prepare("SELECT * FROM pot_declarations").all();
const potEvents = (row: LegalBodyRecord) =>
  s.repo
    .listEvents(row.legalBodyId)
    .filter(
      (e) => e.kind === "note" && String((e.detail as { act?: string })?.act).startsWith("pot"),
    );

/** Neither the registry nor the chain was read. */
function expectNoChainRead(): void {
  expect(registry.getAgentWallet).not.toHaveBeenCalled();
  expect(chain.port.codeHash).not.toHaveBeenCalled();
  expect(chain.port.readPot).not.toHaveBeenCalled();
}

describe("the declaration", () => {
  test("POT_DECLARATION is the pinned version and the guardian's sentence", () => {
    expect(POT_DECLARATION).toEqual({
      version: "pot-declaration-1",
      text: "I declare this pot for the company: it holds the company's money, and its address, its ceiling, what was taken from it and what it holds will show in the public record.",
    });
  });
});

describe("a pot noted", () => {
  test("notes the address a pot of this guardian, this agent's wallet and this ceiling would have (V3), with its birth details", async () => {
    const body = linked();
    const v = await declarePot(deps(), G, body.legalBodyId, V3_INPUT);
    expect(v).toEqual({
      address: V3_INPUT.address,
      onRecord: true,
      declaredAt: NOW_S,
      birth: { saltNonce: "1", agentWallet: A, ceilingUnits: "50000000" },
    });
    expect(pots.list(body.legalBodyId)).toEqual([
      {
        legalBodyId: body.legalBodyId,
        act: "declared",
        address: V3_ADDRESS,
        birth: BIRTH_V3,
        declarationVersion: "pot-declaration-1",
        declaredBy: "guardian",
        declaredAt: NOW_S,
      },
    ]);
    // One registry read, for the body's agent; no code read: the body had no pot before.
    expect(registry.getAgentWallet.mock.calls).toEqual([[BigInt(body.agentId as string)]]);
    expect(chain.port.codeHash).not.toHaveBeenCalled();
    expect(chain.port.readPot).not.toHaveBeenCalled();
  });

  test("addresses in lower case are taken, and stored and answered checksummed", async () => {
    const body = linked();
    const v = await declare(body, {
      ...V3_INPUT,
      address: V3_ADDRESS.toLowerCase(),
      agentWallet: A.toLowerCase(),
    });
    expect(v.address).toBe(V3_ADDRESS);
    expect(v.birth.agentWallet).toBe(A);
  });

  test("writes pot_declared with the declaration's version, from the tenant, in the body's event log, in the same transaction", async () => {
    const body = linked();
    await declare(body, V3_INPUT);
    const events = potEvents(body);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "note",
      actor: "tenant",
      txHash: null,
      detail: { act: "pot_declared", declarationVersion: "pot-declaration-1" },
    });
    expect(Object.keys(events[0]?.detail as object)).toEqual(["act", "declarationVersion"]);
    // One ops line, with the body's id only; no address anywhere in the line or the event.
    const ops = printed.filter((line) => line.includes("legal_body_pot_declared"));
    expect(ops).toHaveLength(1);
    const { opslog, at: _at, ...fields } = JSON.parse(ops[0] as string);
    expect(opslog).toBe("legal_body_pot_declared");
    expect(fields).toEqual({ legalBodyId: body.legalBodyId });
    const written = `${printed.join("\n")}\n${JSON.stringify(events)}`.toLowerCase();
    for (const address of [V3_ADDRESS, A, G]) expect(written).not.toContain(address.toLowerCase());

    // The event and the note are one transaction: an event that fails leaves no note.
    const other = linked();
    const failing = vi.spyOn(s.repo, "recordEvent").mockImplementationOnce(() => {
      throw new Error("the event log failed");
    });
    // Its own pot: an address belongs to one legal body.
    await expect(declare(other, inputFor(60n))).rejects.toThrow("the event log failed");
    failing.mockRestore();
    expect(pots.list(other.legalBodyId)).toEqual([]);
    expect(potEvents(other)).toEqual([]);
  });

  test("refuses pot_declaration_required for another version, or none, and writes nothing", async () => {
    const body = linked();
    const { declarationVersion: _v, ...without } = V3_INPUT;
    for (const input of [
      { ...V3_INPUT, declarationVersion: "pot-declaration-0" },
      { ...V3_INPUT, declarationVersion: "POT-DECLARATION-1" },
      { ...V3_INPUT, declarationVersion: null },
      { ...V3_INPUT, declarationVersion: 1 },
      without,
    ])
      expect(await refusalOf(() => declare(body, input)), JSON.stringify(input)).toMatchObject(
        refused("pot_declaration_required", 400),
      );
    expect(rows()).toEqual([]);
    expect(potEvents(body)).toEqual([]);
    expectNoChainRead();
  });

  test("refuses pot_address_mismatch for another ceiling, another salt, another address, another first key, and writes nothing", async () => {
    const body = linked();
    for (const input of [
      { ...V3_INPUT, ceilingUnits: "20000000" },
      { ...V3_INPUT, saltNonce: "2" },
      { ...V3_INPUT, address: getAddress("0x00000000000000000000000000000000000b0771") },
      { ...V3_INPUT, agentWallet: P },
      // The address of another guardian's pot with the same details.
      { ...V3_INPUT, address: potAddressOf({ guardian: P, ceilingUnits: 50_000_000n }) },
    ])
      expect(await refusalOf(() => declare(body, input)), JSON.stringify(input)).toMatchObject(
        refused("pot_address_mismatch", 409),
      );
    expect(rows()).toEqual([]);
    expectNoChainRead();
  });

  test("refuses pot_address_mismatch when the registry names another wallet than the one the address was built for", async () => {
    const body = linked({ wallet: P });
    expect(await refusalOf(() => declare(body, V3_INPUT))).toMatchObject(
      refused("pot_address_mismatch", 409),
    );
    expect(registry.getAgentWallet).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([]);
  });

  test("refuses agent_wallet_required when the registry names the guardian's wallet, or none", async () => {
    for (const wallet of [G, zeroAddress]) {
      const body = linked({ wallet });
      expect(await refusalOf(() => declare(body, V3_INPUT)), wallet).toMatchObject(
        refused("agent_wallet_required", 409),
      );
    }
    expect(rows()).toEqual([]);
  });

  test("refuses pot_invalid for a sixth key, a ceiling of 2500000 (2.5 USDC), '050000000', a number, a salt of 79 digits", async () => {
    const body = linked();
    for (const input of [
      { ...V3_INPUT, note: "x" },
      { ...V3_INPUT, ceilingUnits: "2500000" },
      { ...V3_INPUT, ceilingUnits: "050000000" },
      { ...V3_INPUT, ceilingUnits: 50_000_000 },
      { ...V3_INPUT, saltNonce: "1".repeat(79) },
      // …and the rest of the shapes the record does not take.
      { ...V3_INPUT, saltNonce: (2n ** 256n).toString() },
      { ...V3_INPUT, saltNonce: "01" },
      { ...V3_INPUT, saltNonce: 1 },
      { ...V3_INPUT, saltNonce: "-1" },
      { ...V3_INPUT, ceilingUnits: "0" },
      { ...V3_INPUT, ceilingUnits: "1" },
      { ...V3_INPUT, ceilingUnits: `${BigInt(POT_CEILING_MAX_USDC + 1) * 1_000_000n}` },
      { ...V3_INPUT, ceilingUnits: "50000000.0" },
      { ...V3_INPUT, address: zeroAddress },
      { ...V3_INPUT, address: `0x${V3_ADDRESS.slice(2).toUpperCase()}` },
      { ...V3_INPUT, address: "0x4a13" },
      { ...V3_INPUT, agentWallet: zeroAddress },
      { ...V3_INPUT, agentWallet: 42 },
      (({ saltNonce: _s, ...rest }) => rest)(V3_INPUT),
      (({ agentWallet: _a, ...rest }) => rest)(V3_INPUT),
      null,
      [],
      "V3",
    ])
      expect(await refusalOf(() => declare(body, input)), JSON.stringify(input)).toMatchObject(
        refused("pot_invalid", 400),
      );
    expect(rows()).toEqual([]);
    expectNoChainRead();
  });

  test("a salt of 2^256 - 1 and the largest ceiling are taken", async () => {
    const body = linked();
    const saltNonce = 2n ** 256n - 1n;
    const ceiling = BigInt(POT_CEILING_MAX_USDC);
    const v = await declare(body, inputFor(ceiling, saltNonce));
    expect(v.birth).toEqual({
      saltNonce: saltNonce.toString(),
      agentWallet: A,
      ceilingUnits: (ceiling * 1_000_000n).toString(),
    });
  });

  test("refuses order_closed for a deployed body and legal_body_revoked for a revoked one, before any chain read", async () => {
    const deployed = potBody(s, { nowMs: clock, state: "deployed" });
    expect(await refusalOf(() => declare(deployed, V3_INPUT))).toMatchObject(
      refused("order_closed", 409),
    );
    const revoked = linked();
    s.repo.recordEvent(revoked.legalBodyId, "revoked", "operator:ops.example", null, {
      reason: "Recorded for a test.",
    });
    expect(await refusalOf(() => declare(revoked, V3_INPUT))).toMatchObject(
      refused("legal_body_revoked", 409),
    );
    expect(rows()).toEqual([]);
    expectNoChainRead();
  });

  test("one 404 for an unknown body and for another tenant's", async () => {
    const body = linked();
    expect(await refusalOf(() => declare(body, V3_INPUT, STRANGER))).toMatchObject(
      refused("not_found", 404),
    );
    expect(
      await refusalOf(() => declarePot(deps(), G, `lb_${"0".repeat(36)}`, V3_INPUT)),
    ).toMatchObject(refused("not_found", 404));
    expectNoChainRead();
  });

  test("refuses pot_chain_unsupported on a chain the pot is not offered on, before any chain read", async () => {
    const body = linked();
    expect(
      await refusalOf(() => declarePot(deps({ chainId: 1 }), G, body.legalBodyId, V3_INPUT)),
    ).toMatchObject(refused("pot_chain_unsupported", 409));
    expect(rows()).toEqual([]);
    expectNoChainRead();
  });

  test("while the pot is not offered: the note is pot_not_offered before anything is read; the read answers the notes as before, with no chain read (Ruling R27)", async () => {
    const body = linked();
    offered = false;
    const findOwned = vi.spyOn(s.repo, "findOwned");
    expect(await refusalOf(() => declare(body, V3_INPUT))).toMatchObject(
      refused("pot_not_offered", 409),
    );
    expect(findOwned).not.toHaveBeenCalled();
    expect(orderPot(deps(), G, body.legalBodyId)).toEqual({ pot: null });
    expect(rows()).toEqual([]);
    expectNoChainRead();
    offered = true;
    expect((await declare(body, V3_INPUT)).address).toBe(V3_ADDRESS);
    registry.getAgentWallet.mockClear();
    offered = false;
    expect(orderPot(deps(), G, body.legalBodyId)).toEqual({
      pot: { address: V3_ADDRESS, onRecord: true, declaredAt: NOW_S, birth: BIRTH_V3 },
    });
    // Still one 404 for a body that is not the tenant's, flag or not.
    expect(await refusalOf(() => orderPot(deps(), P, body.legalBodyId))).toMatchObject(
      refused("not_found", 404),
    );
    expectNoChainRead();
  });
});

describe("one pot for life", () => {
  test("answers the stored note for the same address again, and appends nothing", async () => {
    const body = linked();
    const first = await declare(body, V3_INPUT);
    clock += 60_000;
    registry.getAgentWallet.mockClear();
    const again = await declare(body, { ...V3_INPUT, address: V3_ADDRESS.toLowerCase() });
    expect(again).toEqual(first);
    expect(rows()).toHaveLength(1);
    expect(potEvents(body)).toHaveLength(1);
    expectNoChainRead();
  });

  test("Ruling R22: a new address while the latest declared note holds no code is pot_pending, before the registry, and nothing is written; once it holds code, pot_exists", async () => {
    const body = linked();
    await declare(body, V3_INPUT);
    clock += 60_000;
    registry.getAgentWallet.mockClear();
    // The first pot was never created: it is still being set up, and it is finished at its own
    // address. A second address never takes its place.
    const second = inputFor(60n);
    expect(await refusalOf(() => declare(body, second))).toMatchObject(refused("pot_pending", 409));
    expect(chain.port.codeHash.mock.calls).toEqual([[V3_ADDRESS]]);
    expect(registry.getAgentWallet).not.toHaveBeenCalled();
    expect(pots.list(body.legalBodyId)).toHaveLength(1);
    expect(potEvents(body)).toHaveLength(1);
    // The noted address itself is answered as stored.
    expect(await declare(body, V3_INPUT)).toMatchObject({ address: V3_ADDRESS, onRecord: true });
    // Once it holds code, another address is pot_exists.
    chain.codes.set(V3_ADDRESS.toLowerCase(), SOME_CODE);
    clock += 60_000;
    expect(await refusalOf(() => declare(body, second))).toMatchObject(refused("pot_exists", 409));
    expect(pots.list(body.legalBodyId)).toHaveLength(1);
    expect(potEvents(body)).toHaveLength(1);
  });

  test("Ruling R22: taken off the record, the code-less noted pot is still the one being set up: a new address is pot_pending, and its put-back stands", async () => {
    const body = linked();
    await declare(body, V3_INPUT);
    clock += 60_000;
    removePot(deps(), G, body.legalBodyId);
    clock += 60_000;
    expect(await refusalOf(() => declare(body, inputFor(60n)))).toMatchObject(
      refused("pot_pending", 409),
    );
    clock += 60_000;
    expect(await declare(body, V3_INPUT)).toMatchObject({ address: V3_ADDRESS, onRecord: true });
    expect(pots.list(body.legalBodyId).map((n) => n.act)).toEqual([
      "declared",
      "removed",
      "declared",
    ]);
  });

  test("Ruling R22 on a record written before it: two code-less notes, a third address is pot_pending; the latest one's put-back is answered, and the earlier one's is written again", async () => {
    const body = linked();
    await declare(body, V3_INPUT);
    clock += 60_000;
    const second = inputFor(60n);
    noteBeforeR22(body, second);
    clock += 60_000;
    expect(await refusalOf(() => declare(body, inputFor(70n)))).toMatchObject(
      refused("pot_pending", 409),
    );
    expect(await declare(body, second)).toMatchObject({ address: second.address, onRecord: true });
    expect(pots.list(body.legalBodyId)).toHaveLength(2);
    // An address the body declared before is a put-back, never a new pot: R22 leaves it alone.
    clock += 60_000;
    expect(await declare(body, V3_INPUT)).toMatchObject({ address: V3_ADDRESS, onRecord: true });
    expect(pots.list(body.legalBodyId)).toHaveLength(3);
  });

  test("a former pot that got its code after it was replaced (a record written before Ruling R22) still holds the body to it: no other pot, but it can be put back", async () => {
    const body = linked();
    await declare(body, V3_INPUT);
    clock += 60_000;
    const second = inputFor(60n);
    noteBeforeR22(body, second);
    // The first pot's setup, sent from a tab before the replacement, lands now.
    chain.codes.set(V3_ADDRESS.toLowerCase(), SOME_CODE);
    clock += 60_000;
    expect(await refusalOf(() => declare(body, inputFor(70n)))).toMatchObject(
      refused("pot_exists", 409),
    );
    // The pot that holds the code is put back on the record, the other one checked first.
    registry.getAgentWallet.mockClear();
    chain.port.codeHash.mockClear();
    const back = await declare(body, V3_INPUT);
    expect(back).toMatchObject({ address: V3_ADDRESS, onRecord: true, birth: BIRTH_V3 });
    expect(chain.port.codeHash.mock.calls).toEqual([[second.address]]);
    expect(registry.getAgentWallet).not.toHaveBeenCalled();
    // …and the one that never got code cannot come back while the first holds it.
    clock += 60_000;
    expect(await refusalOf(() => declare(body, second))).toMatchObject(refused("pot_exists", 409));
  });

  test("a put-back of an address this body declared before, after a removed note, appends a declared note with no registry read, even when the registry names another key today", async () => {
    const body = linked();
    await declare(body, V3_INPUT);
    clock += 60_000;
    pots.append({
      legalBodyId: body.legalBodyId,
      act: "removed",
      address: V3_ADDRESS,
      birth: null,
      declarationVersion: null,
      at: Math.floor(clock / 1000),
    });
    // The agent has a new key on the same pot.
    registry.wallets.set(body.agentId as string, P);
    registry.getAgentWallet.mockClear();
    clock += 60_000;
    const back = await declare(body, V3_INPUT);
    expect(back).toEqual({
      address: V3_ADDRESS,
      onRecord: true,
      declaredAt: NOW_S + 120,
      birth: BIRTH_V3,
    });
    expect(pots.list(body.legalBodyId).map((n) => n.act)).toEqual([
      "declared",
      "removed",
      "declared",
    ]);
    expect(potEvents(body).map((e) => e.detail)).toEqual([
      { act: "pot_declared", declarationVersion: "pot-declaration-1" },
      { act: "pot_declared", declarationVersion: "pot-declaration-1" },
    ]);
    expectNoChainRead();
  });

  test("after a removed note, another address is a new pot: refused while the removed one holds code", async () => {
    const body = linked();
    await declare(body, V3_INPUT);
    chain.codes.set(V3_ADDRESS.toLowerCase(), SOME_CODE);
    clock += 60_000;
    pots.append({
      legalBodyId: body.legalBodyId,
      act: "removed",
      address: V3_ADDRESS,
      birth: null,
      declarationVersion: null,
      at: Math.floor(clock / 1000),
    });
    clock += 60_000;
    expect(await refusalOf(() => declare(body, inputFor(60n)))).toMatchObject(
      refused("pot_exists", 409),
    );
    expect(registry.getAgentWallet).toHaveBeenCalledTimes(1);
  });

  test("the same note written by another request while this one read the chain is answered, never written twice", async () => {
    const body = linked();
    const d = deps();
    // This request reads the notes before the other request's note is written…
    const list = vi.spyOn(d.repo, "list").mockReturnValueOnce([]);
    // …and the other request writes it while this one reads the registry.
    registry.getAgentWallet.mockImplementationOnce(async () => {
      await declarePot(deps(), G, body.legalBodyId, V3_INPUT);
      return A;
    });
    const v = await declarePot(d, G, body.legalBodyId, V3_INPUT);
    list.mockRestore();
    expect(v).toEqual({ address: V3_ADDRESS, onRecord: true, declaredAt: NOW_S, birth: BIRTH_V3 });
    expect(rows()).toHaveLength(1);
    expect(potEvents(body)).toHaveLength(1);
    expect(printed.filter((line) => line.includes("legal_body_pot_declared"))).toHaveLength(1);
  });

  test("a former pot that lands after it was replaced (a record written before Ruling R22): the replacement posted again is pot_exists, not answered", async () => {
    // Y noted, its setup sent from a tab that was lost; X noted in its place while Y had no code.
    const body = linked();
    const y = V3_INPUT;
    const x = inputFor(60n);
    await declare(body, y);
    clock += 60_000;
    noteBeforeR22(body, x);
    // Y's setup lands. X posted again, as the website would before offering X's setup.
    chain.codes.set(V3_ADDRESS.toLowerCase(), SOME_CODE);
    chain.port.codeHash.mockClear();
    clock += 60_000;
    expect(await refusalOf(() => declare(body, x))).toMatchObject(refused("pot_exists", 409));
    // Y read, then X's own code: X holds none.
    expect(chain.port.codeHash.mock.calls).toEqual([[V3_ADDRESS], [x.address]]);
    expect(pots.list(body.legalBodyId)).toHaveLength(2);
    // Y, which holds the code, is still the one that can come back.
    expect(await declare(body, y)).toMatchObject({ address: V3_ADDRESS, onRecord: true });
  });

  test("two pots that both hold code (a record written before Ruling R22): with the latest taken off, each can be put back, and a new pot cannot", async () => {
    const body = linked();
    const y = V3_INPUT;
    const x = inputFor(60n);
    await declare(body, y);
    clock += 60_000;
    noteBeforeR22(body, x);
    // Both setups landed: the body holds two pots.
    chain.codes.set(V3_ADDRESS.toLowerCase(), SOME_CODE);
    chain.codes.set((x.address as string).toLowerCase(), SOME_CODE);
    const takeOff = (address: Address) => {
      clock += 60_000;
      pots.append({
        legalBodyId: body.legalBodyId,
        act: "removed",
        address,
        birth: null,
        declarationVersion: null,
        at: Math.floor(clock / 1000),
      });
    };
    // X, the latest, taken off; X put back.
    takeOff(x.address as Address);
    clock += 60_000;
    expect(await declare(body, x)).toMatchObject({ address: x.address, onRecord: true });
    // X taken off again; Y put back instead.
    takeOff(x.address as Address);
    clock += 60_000;
    expect(await declare(body, y)).toMatchObject({ address: V3_ADDRESS, onRecord: true });
    // The one on the record posted again is answered; X now comes back over Y.
    clock += 60_000;
    expect(await declare(body, y)).toMatchObject({ address: V3_ADDRESS, onRecord: true });
    clock += 60_000;
    expect(await declare(body, x)).toMatchObject({ address: x.address, onRecord: true });
    // A third, new pot stays refused, even one whose address already holds code.
    clock += 60_000;
    const third = inputFor(70n);
    expect(await refusalOf(() => declare(body, third))).toMatchObject(refused("pot_exists", 409));
    chain.codes.set((third.address as string).toLowerCase(), SOME_CODE);
    expect(await refusalOf(() => declare(body, third))).toMatchObject(refused("pot_exists", 409));
    expect(pots.list(body.legalBodyId).map((n) => n.act)).toEqual([
      "declared",
      "declared",
      "removed",
      "declared",
      "removed",
      "declared",
      "declared",
    ]);
  });

  test("declared X, declared Y (a record written before Ruling R22), Y taken off, then X gets its code: the put-back of Y, which holds none, is pot_exists, and the put-back of X stands", async () => {
    const body = linked();
    const x = V3_INPUT;
    const y = inputFor(60n);
    await declare(body, x);
    clock += 60_000;
    noteBeforeR22(body, y);
    clock += 60_000;
    removePot(deps(), G, body.legalBodyId);
    // X's setup, sent from a tab before Y replaced it, lands now.
    chain.codes.set(V3_ADDRESS.toLowerCase(), SOME_CODE);
    chain.port.codeHash.mockClear();
    registry.getAgentWallet.mockClear();
    clock += 60_000;
    expect(await refusalOf(() => declare(body, y))).toMatchObject(refused("pot_exists", 409));
    // X read (it holds code), then Y's own code: Y holds none.
    expect(chain.port.codeHash.mock.calls).toEqual([[V3_ADDRESS], [y.address]]);
    expect(pots.list(body.legalBodyId).map((n) => n.act)).toEqual([
      "declared",
      "declared",
      "removed",
    ]);
    // X, which holds the code, comes back: Y is read and holds none; no registry read.
    chain.port.codeHash.mockClear();
    clock += 60_000;
    expect(await declare(body, x)).toEqual({
      address: V3_ADDRESS,
      onRecord: true,
      // X noted, Y noted a minute later, Y taken off, Y refused, X put back: four minutes on.
      declaredAt: NOW_S + 240,
      birth: BIRTH_V3,
    });
    expect(chain.port.codeHash.mock.calls).toEqual([[y.address]]);
    expect(registry.getAgentWallet).not.toHaveBeenCalled();
    expect(pots.list(body.legalBodyId).map((n) => [n.act, n.address])).toEqual([
      ["declared", V3_ADDRESS],
      ["declared", y.address],
      ["removed", y.address],
      ["declared", V3_ADDRESS],
    ]);
  });

  test("the code of the other noted addresses is read at once, not one after the other", async () => {
    const body = linked();
    await declare(body, V3_INPUT);
    clock += 60_000;
    noteBeforeR22(body, inputFor(60n));
    clock += 60_000;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    chain.port.codeHash.mockClear();
    chain.port.codeHash.mockImplementation(async () => {
      await gate;
      return null;
    });
    const pending = refusalOf(() => declare(body, inputFor(70n)));
    await vi.waitFor(() => expect(chain.port.codeHash).toHaveBeenCalledTimes(2));
    release();
    // Both hold none: the latest one is still being set up (Ruling R22).
    expect(await pending).toMatchObject(refused("pot_pending", 409));
  });

  test("two different addresses posted at once: the later write checks again against the note written first, and is pot_pending while that one holds no code (Ruling R22)", async () => {
    const body = linked();
    const first = inputFor(60n);
    // The other request lands while this one reads the registry.
    registry.getAgentWallet.mockImplementationOnce(async () => {
      await declarePot(deps(), G, body.legalBodyId, first);
      return A;
    });
    expect(await refusalOf(() => declare(body, V3_INPUT))).toMatchObject(
      refused("pot_pending", 409),
    );
    // The check was made again with the other request's note: its code was read.
    expect(chain.port.codeHash.mock.calls).toEqual([[first.address]]);
    expect(pots.list(body.legalBodyId).map((n) => n.address)).toEqual([first.address]);
    expect(potEvents(body)).toHaveLength(1);
  });

  test("two different addresses posted at once, the first created at once: the later one is pot_exists", async () => {
    const body = linked();
    const first = inputFor(60n);
    registry.getAgentWallet.mockImplementationOnce(async () => {
      await declarePot(deps(), G, body.legalBodyId, first);
      chain.codes.set((first.address as string).toLowerCase(), SOME_CODE);
      return A;
    });
    expect(await refusalOf(() => declare(body, V3_INPUT))).toMatchObject(
      refused("pot_exists", 409),
    );
    expect(pots.list(body.legalBodyId).map((n) => n.address)).toEqual([first.address]);
    expect(potEvents(body)).toHaveLength(1);
  });

  test("a code read that fails is 503 chain_unavailable, and nothing is noted", async () => {
    const body = linked();
    await declare(body, V3_INPUT);
    chain.port.codeHash.mockRejectedValueOnce(new Error("the node did not answer"));
    clock += 60_000;
    expect(await refusalOf(() => declare(body, inputFor(60n)))).toMatchObject(
      refused("chain_unavailable", 503),
    );
    // The registry is read for a new pot of a body with no note being set up.
    const fresh = linked();
    registry.getAgentWallet.mockRejectedValueOnce(new Error("the node did not answer"));
    clock += 60_000;
    expect(await refusalOf(() => declare(fresh, inputFor(70n)))).toMatchObject(
      refused("chain_unavailable", 503),
    );
    expect(pots.list(body.legalBodyId)).toHaveLength(1);
    expect(pots.list(fresh.legalBodyId)).toHaveLength(0);
  });
});

describe("an address belongs to one legal body (Ruling R13)", () => {
  test("an address another body of the same guardian noted is pot_taken, before any chain read", async () => {
    const first = linked();
    const second = linked();
    await declare(first, V3_INPUT);
    registry.getAgentWallet.mockClear();
    clock += 60_000;
    expect(await refusalOf(() => declare(second, V3_INPUT))).toMatchObject(
      refused("pot_taken", 409),
    );
    expect(pots.list(second.legalBodyId)).toEqual([]);
    expectNoChainRead();
    // …and taken off the first body's record, it is still the first body's.
    pots.append({
      legalBodyId: first.legalBodyId,
      act: "removed",
      address: V3_ADDRESS,
      birth: null,
      declarationVersion: null,
      at: Math.floor(clock / 1000),
    });
    clock += 60_000;
    expect(await refusalOf(() => declare(second, V3_INPUT))).toMatchObject(
      refused("pot_taken", 409),
    );
  });

  test("an address a body of another guardian holds a note of is pot_taken, for a new pot and for a put-back", async () => {
    const body = linked();
    await declare(body, V3_INPUT);
    clock += 60_000;
    pots.append({
      legalBodyId: body.legalBodyId,
      act: "removed",
      address: V3_ADDRESS,
      birth: null,
      declarationVersion: null,
      at: Math.floor(clock / 1000),
    });
    // A note of the same address on another guardian's body, written around the door.
    const elsewhere = potBody(s, { nowMs: clock, tenant: STRANGER });
    pots.append({
      legalBodyId: elsewhere.legalBodyId,
      act: "declared",
      address: V3_ADDRESS,
      birth: BIRTH_V3,
      declarationVersion: "pot-declaration-1",
      at: Math.floor(clock / 1000),
    });
    const fresh = linked();
    registry.getAgentWallet.mockClear();
    clock += 60_000;
    for (const row of [body, fresh])
      expect(await refusalOf(() => declare(row, V3_INPUT)), row.legalBodyId).toMatchObject(
        refused("pot_taken", 409),
      );
    expectNoChainRead();
    expect(pots.list(body.legalBodyId).map((n) => n.act)).toEqual(["declared", "removed"]);
    expect(pots.list(fresh.legalBodyId)).toEqual([]);
    // Even when this body holds the newer note of the address (both written around the door).
    pots.append({
      legalBodyId: body.legalBodyId,
      act: "declared",
      address: V3_ADDRESS,
      birth: BIRTH_V3,
      declarationVersion: "pot-declaration-1",
      at: Math.floor(clock / 1000),
    });
    clock += 60_000;
    expect(await refusalOf(() => declare(body, V3_INPUT))).toMatchObject(refused("pot_taken", 409));
  });

  test("the same address posted to two bodies at once (Ruling R29): both pass the early check and wait on the registry; one note is written, the other is pot_taken", async () => {
    // Two linked bodies of G whose agents share one registry wallet: the same address, salt and
    // ceiling recompute for both.
    const first = linked();
    const second = linked();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    registry.getAgentWallet.mockImplementation(async () => {
      await gate;
      return A;
    });
    const one = declare(first, V3_INPUT).then(
      (view) => ({ view }),
      (err: unknown) => ({ err }),
    );
    const two = declare(second, V3_INPUT).then(
      (view) => ({ view }),
      (err: unknown) => ({ err }),
    );
    // Both are past the early check (step 6) and wait at the registry read (step 9).
    await vi.waitFor(() => expect(registry.getAgentWallet).toHaveBeenCalledTimes(2));
    expect(rows()).toEqual([]);
    release();
    const outcomes = await Promise.all([one, two]);
    const written = outcomes.filter((o) => "view" in o);
    const refusedOnes = outcomes.filter((o) => "err" in o);
    expect(written).toHaveLength(1);
    expect(refusedOnes).toHaveLength(1);
    expect((refusedOnes[0] as { err: unknown }).err).toMatchObject(refused("pot_taken", 409));
    expect(rows()).toHaveLength(1);
    const holders = pots.legalBodyIdsByAddress(V3_ADDRESS, 10);
    expect(holders).toHaveLength(1);
    expect([first.legalBodyId, second.legalBodyId]).toContain(holders[0]);
    // The body refused wrote nothing, in its notes or in its event log.
    const loser = holders[0] === first.legalBodyId ? second : first;
    expect(pots.list(loser.legalBodyId)).toEqual([]);
    expect(potEvents(loser)).toEqual([]);
  });
});

describe("the ceiling under the agent's grant (Ruling R12)", () => {
  test("the order's grant caps the ceiling at the thirty-day amounts of buying, paying and engaging contractors: above is ceiling_above_grant, at it is noted", async () => {
    // Grant A allows 1,000 for each of the three kinds: 3,000 in all.
    const body = linked({ grant: GRANT_A });
    expect(await refusalOf(() => declare(body, inputFor(3_001n)))).toMatchObject(
      refused("ceiling_above_grant", 409),
    );
    expect(rows()).toEqual([]);
    expectNoChainRead();
    const at = await declare(body, inputFor(3_000n));
    expect(at.birth.ceilingUnits).toBe("3000000000");
  });

  test("a grant that allows none of the three kinds takes no pot: grant_allows_no_spending, whatever the ceiling", async () => {
    const body = linked({ grant: NO_SPENDING });
    for (const usdc of [1n, 50n])
      expect(await refusalOf(() => declare(body, inputFor(usdc))), String(usdc)).toMatchObject(
        refused("grant_allows_no_spending", 409),
      );
    expect(rows()).toEqual([]);
    expectNoChainRead();
  });

  test("an order with no grant takes any ceiling up to the largest", async () => {
    const body = linked();
    const v = await declare(body, inputFor(BigInt(POT_CEILING_MAX_USDC)));
    expect(v.birth.ceilingUnits).toBe(`${BigInt(POT_CEILING_MAX_USDC) * 1_000_000n}`);
  });

  test("an agreement that no longer reads back is 500 agreement_unreadable, and nothing is noted", async () => {
    const body = linked({ grant: GRANT_A });
    vi.spyOn(s.docStore, "getBytes").mockImplementation(() => {
      throw new Error("no such file");
    });
    expect(await refusalOf(() => declare(body, V3_INPUT))).toMatchObject(
      refused("agreement_unreadable", 500),
    );
    expect(rows()).toEqual([]);
    expectNoChainRead();
  });
});

describe("orderPot", () => {
  test("orderPot answers null with no note, onRecord false after a removed note, and one 404 for another tenant's body", async () => {
    const body = linked();
    expect(orderPot(deps(), G, body.legalBodyId)).toEqual({ pot: null });
    const declared = await declare(body, V3_INPUT);
    // The note read the registry; the reads below read nothing.
    registry.getAgentWallet.mockClear();
    expect(orderPot(deps(), G, body.legalBodyId)).toEqual({ pot: declared });
    clock += 60_000;
    pots.append({
      legalBodyId: body.legalBodyId,
      act: "removed",
      address: V3_ADDRESS,
      birth: null,
      declarationVersion: null,
      at: Math.floor(clock / 1000),
    });
    expect(orderPot(deps(), G, body.legalBodyId)).toEqual({
      pot: { address: V3_ADDRESS, onRecord: false, declaredAt: NOW_S, birth: BIRTH_V3 },
    });
    expect(await refusalOf(() => orderPot(deps(), STRANGER, body.legalBodyId))).toMatchObject(
      refused("not_found", 404),
    );
    expect(await refusalOf(() => orderPot(deps(), G, `lb_${"0".repeat(36)}`))).toMatchObject(
      refused("not_found", 404),
    );
    expectNoChainRead();
  });

  test("the birth details and time are those of the latest declared note of the address on the record", async () => {
    const body = linked();
    await declare(body, V3_INPUT);
    clock += 60_000;
    const second = inputFor(60n);
    noteBeforeR22(body, second);
    expect(orderPot(deps(), G, body.legalBodyId)).toEqual({
      pot: {
        address: second.address,
        onRecord: true,
        declaredAt: NOW_S + 60,
        birth: { saltNonce: "1", agentWallet: A, ceilingUnits: "60000000" },
      },
    });
  });
});

describe("taking the pot off the public record", () => {
  const takeOff = (row: LegalBodyRecord, tenant: Address = G) =>
    removePot(deps(), tenant, row.legalBodyId);
  const acts = (row: LegalBodyRecord) => pots.list(row.legalBodyId).map((n) => n.act);
  const eventActs = (row: LegalBodyRecord) =>
    potEvents(row).map((e) => (e.detail as { act: string }).act);
  const removedLines = () => printed.filter((line) => line.includes("legal_body_pot_removed"));

  test("appends a removed note of the address on the record and writes pot_removed; the view and orderPot answer onRecord false with the same address and birth details", async () => {
    const body = linked();
    const declared = await declare(body, V3_INPUT);
    registry.getAgentWallet.mockClear();
    clock += 60_000;
    const v = takeOff(body);
    expect(v).toEqual({ address: V3_ADDRESS, onRecord: false, declaredAt: NOW_S, birth: BIRTH_V3 });
    expect(orderPot(deps(), G, body.legalBodyId)).toEqual({
      pot: { ...declared, onRecord: false },
    });
    expect(pots.list(body.legalBodyId)).toEqual([
      {
        legalBodyId: body.legalBodyId,
        act: "declared",
        address: V3_ADDRESS,
        birth: BIRTH_V3,
        declarationVersion: "pot-declaration-1",
        declaredBy: "guardian",
        declaredAt: NOW_S,
      },
      {
        legalBodyId: body.legalBodyId,
        act: "removed",
        address: V3_ADDRESS,
        birth: null,
        declarationVersion: null,
        declaredBy: "guardian",
        declaredAt: NOW_S + 60,
      },
    ]);
    const events = potEvents(body);
    expect(events.map((e) => e.detail)).toEqual([
      { act: "pot_declared", declarationVersion: "pot-declaration-1" },
      { act: "pot_removed" },
    ]);
    expect(events[1]).toMatchObject({ kind: "note", actor: "tenant", txHash: null });
    // One ops line, with the body's id only; no address anywhere in the line or the event.
    const ops = removedLines();
    expect(ops).toHaveLength(1);
    const { opslog, at: _at, ...fields } = JSON.parse(ops[0] as string);
    expect(opslog).toBe("legal_body_pot_removed");
    expect(fields).toEqual({ legalBodyId: body.legalBodyId });
    const written = `${ops.join("\n")}\n${JSON.stringify(events)}`.toLowerCase();
    for (const address of [V3_ADDRESS, A, G]) expect(written).not.toContain(address.toLowerCase());
    // The pot itself is untouched: neither the chain nor the registry was read.
    expectNoChainRead();
    // A lookup by its address still finds the body: a former pot.
    expect(pots.legalBodyIdsByAddress(V3_ADDRESS, 10)).toEqual([body.legalBodyId]);
  });

  test("a removal with no note, and a second removal, are 409 pot_not_on_record, and write nothing", async () => {
    const body = linked();
    expect(await refusalOf(() => takeOff(body))).toMatchObject(refused("pot_not_on_record", 409));
    expect(rows()).toEqual([]);
    expect(potEvents(body)).toEqual([]);
    await declare(body, V3_INPUT);
    clock += 60_000;
    takeOff(body);
    clock += 60_000;
    expect(await refusalOf(() => takeOff(body))).toMatchObject(refused("pot_not_on_record", 409));
    expect(acts(body)).toEqual(["declared", "removed"]);
    expect(eventActs(body)).toEqual(["pot_declared", "pot_removed"]);
    expect(removedLines()).toHaveLength(1);
  });

  test("with a former pot (a record written before Ruling R22), the one taken off is the address on the record, with its own birth details", async () => {
    const body = linked();
    await declare(body, V3_INPUT);
    clock += 60_000;
    const second = inputFor(60n);
    noteBeforeR22(body, second);
    chain.port.codeHash.mockClear();
    registry.getAgentWallet.mockClear();
    clock += 60_000;
    expect(takeOff(body)).toEqual({
      address: second.address,
      onRecord: false,
      declaredAt: NOW_S + 60,
      birth: { saltNonce: "1", agentWallet: A, ceilingUnits: "60000000" },
    });
    expect(pots.latest(body.legalBodyId)).toMatchObject({
      act: "removed",
      address: second.address,
    });
    // The former pot was never on the record since: nothing more to take off.
    expect(await refusalOf(() => takeOff(body))).toMatchObject(refused("pot_not_on_record", 409));
    expectNoChainRead();
  });

  test("in any state: a revoked body's pot and a broken body's pot can be taken off; a revoked body with no note is pot_not_on_record", async () => {
    const revoked = linked();
    await declare(revoked, V3_INPUT);
    s.repo.recordEvent(revoked.legalBodyId, "revoked", "operator:ops.example", null, {
      reason: "Recorded for a test.",
    });
    clock += 60_000;
    expect(takeOff(revoked)).toMatchObject({ address: V3_ADDRESS, onRecord: false });
    expect(eventActs(revoked)).toEqual(["pot_declared", "pot_removed"]);

    const broken = linked();
    const its = inputFor(60n);
    await declare(broken, its);
    expect(s.repo.markBroken(broken.legalBodyId, { reason: "a test" })).toBe(true);
    clock += 60_000;
    expect(takeOff(broken)).toMatchObject({ address: its.address, onRecord: false });

    const bare = linked();
    s.repo.recordEvent(bare.legalBodyId, "revoked", "operator:ops.example", null, {
      reason: "Recorded for a test.",
    });
    expect(await refusalOf(() => takeOff(bare))).toMatchObject(refused("pot_not_on_record", 409));
    expect(pots.list(bare.legalBodyId)).toEqual([]);
  });

  test("one 404 for another tenant's body and for an unknown id, and nothing is written", async () => {
    const body = linked();
    await declare(body, V3_INPUT);
    registry.getAgentWallet.mockClear();
    clock += 60_000;
    expect(await refusalOf(() => takeOff(body, STRANGER))).toMatchObject(refused("not_found", 404));
    expect(await refusalOf(() => removePot(deps(), G, `lb_${"0".repeat(36)}`))).toMatchObject(
      refused("not_found", 404),
    );
    expect(acts(body)).toEqual(["declared"]);
    expect(eventActs(body)).toEqual(["pot_declared"]);
    expect(removedLines()).toEqual([]);
    expectNoChainRead();
  });

  test("while the pot is not offered, it is taken off all the same: a guardian may always withdraw a claim (Ruling R15 a)", async () => {
    const body = linked();
    await declare(body, V3_INPUT);
    registry.getAgentWallet.mockClear();
    offered = false;
    clock += 60_000;
    expect(takeOff(body)).toEqual({
      address: V3_ADDRESS,
      onRecord: false,
      declaredAt: NOW_S,
      birth: BIRTH_V3,
    });
    expect(acts(body)).toEqual(["declared", "removed"]);
    expect(eventActs(body)).toEqual(["pot_declared", "pot_removed"]);
    expect(removedLines()).toHaveLength(1);
    expectNoChainRead();
    // The read answers the pot, off the record, while the flag is off (Ruling R27); the note door
    // still answers pot_not_offered.
    expect(orderPot(deps(), G, body.legalBodyId)).toEqual({
      pot: { address: V3_ADDRESS, onRecord: false, declaredAt: NOW_S, birth: BIRTH_V3 },
    });
    expect(await refusalOf(() => declare(body, V3_INPUT))).toMatchObject(
      refused("pot_not_offered", 409),
    );
  });

  test("the removed note and its event are one transaction: an event that fails leaves the pot on the record", async () => {
    const body = linked();
    await declare(body, V3_INPUT);
    clock += 60_000;
    const failing = vi.spyOn(s.repo, "recordEvent").mockImplementationOnce(() => {
      throw new Error("the event log failed");
    });
    expect(() => takeOff(body)).toThrow("the event log failed");
    failing.mockRestore();
    expect(acts(body)).toEqual(["declared"]);
    expect(eventActs(body)).toEqual(["pot_declared"]);
    expect(removedLines()).toEqual([]);
    expect(orderPot(deps(), G, body.legalBodyId).pot?.onRecord).toBe(true);
  });

  test("the notes are read inside the transaction the removed note is written in", async () => {
    const body = linked();
    await declare(body, V3_INPUT);
    clock += 60_000;
    const d = deps();
    let inside = false;
    const run = s.repo.transaction.bind(s.repo);
    vi.spyOn(s.repo, "transaction").mockImplementation(
      <T>(fn: () => T): T =>
        run(() => {
          inside = true;
          try {
            return fn();
          } finally {
            inside = false;
          }
        }),
    );
    const readsInside: boolean[] = [];
    const list = d.repo.list.bind(d.repo);
    const latest = d.repo.latest.bind(d.repo);
    vi.spyOn(d.repo, "list").mockImplementation((id) => {
      readsInside.push(inside);
      return list(id);
    });
    vi.spyOn(d.repo, "latest").mockImplementation((id) => {
      readsInside.push(inside);
      return latest(id);
    });
    removePot(d, G, body.legalBodyId);
    expect(readsInside.length).toBeGreaterThan(0);
    expect(readsInside.every(Boolean)).toBe(true);
  });

  test("taken off, the address is still this body's: another legal body is pot_taken, and this body puts it back through the note door, as before", async () => {
    const body = linked();
    const other = linked();
    await declare(body, V3_INPUT);
    clock += 60_000;
    takeOff(body);
    registry.getAgentWallet.mockClear();
    clock += 60_000;
    expect(await refusalOf(() => declare(other, V3_INPUT))).toMatchObject(
      refused("pot_taken", 409),
    );
    expect(pots.list(other.legalBodyId)).toEqual([]);
    expectNoChainRead();
    // The put-back: a declared note, with no registry read and no code read (no other address).
    const back = await declare(body, V3_INPUT);
    expect(back).toEqual({
      address: V3_ADDRESS,
      onRecord: true,
      declaredAt: NOW_S + 120,
      birth: BIRTH_V3,
    });
    expectNoChainRead();
    expect(acts(body)).toEqual(["declared", "removed", "declared"]);
    expect(eventActs(body)).toEqual(["pot_declared", "pot_removed", "pot_declared"]);
    // …and it can be taken off again.
    clock += 60_000;
    expect(takeOff(body)).toEqual({
      address: V3_ADDRESS,
      onRecord: false,
      declaredAt: NOW_S + 120,
      birth: BIRTH_V3,
    });
    expect(acts(body)).toEqual(["declared", "removed", "declared", "removed"]);
  });

  test("taken off, a pot that holds code still holds the body to it: another address is pot_exists", async () => {
    const body = linked();
    await declare(body, V3_INPUT);
    chain.codes.set(V3_ADDRESS.toLowerCase(), SOME_CODE);
    clock += 60_000;
    takeOff(body);
    clock += 60_000;
    expect(await refusalOf(() => declare(body, inputFor(60n)))).toMatchObject(
      refused("pot_exists", 409),
    );
    expect(acts(body)).toEqual(["declared", "removed"]);
  });
});

// ---------------------------------------------------------------------------------------------
// The pot in the public record
// ---------------------------------------------------------------------------------------------

/** When the pot of the record's tests was declared: an hour before the statement's clock. */
const DECLARED_AT = CLOCK_S - 3_600;
/** The statement chain's head: every statement here is observed at it. */
const BLOCK = 4_242n;
/** What every block naming V3 on the record carries beside its reading: the statement's block and
 *  issue, and the latest declaration of V3 with its birth details. */
const V3_FACTS = {
  readAtBlock: "4242",
  readAt: CLOCK_S,
  declaredBy: "guardian",
  declaredAt: DECLARED_AT,
  birth: servedBirth(),
};
/** A node failure as a client throws one, its message quoting the node's URL. */
const nodeError = () =>
  Object.assign(new Error("HTTP request failed. URL: https://rpc.example/v2/key-in-path"), {
    name: "HttpRequestError",
  });

/** The fields of the ops lines printed for `event`, without `opslog` and `at`. */
const linesOf = (event: string): Record<string, unknown>[] =>
  printed.flatMap((line) => {
    try {
      const { opslog, at: _at, ...fields } = JSON.parse(line);
      return opslog === event ? [fields] : [];
    } catch {
      return [];
    }
  });

type Stated = Extract<StatementOutcome, { kind: "statement" }>;

describe("the pot beside a signed statement (potOfStatement)", () => {
  let stChain: FakeStatementChain;
  beforeEach(() => {
    stChain = new FakeStatementChain();
  });

  /** The statement the lookups serve for the body's agent, made now. */
  async function statementOf(row: LegalBodyRecord): Promise<Stated> {
    const out = await statementForAgent(statementDeps(s, stChain), row.agentId as string);
    if (out.kind !== "statement") throw new Error(`expected a statement, got ${out.kind}`);
    return out;
  }
  /** A body of G stated by the statement service, with V3 noted for it an hour before. */
  function withV3(o: Parameters<typeof statedPotBody>[2] = {}): LegalBodyRecord {
    const row = statedPotBody(s, stChain, o);
    notePot(pots, row, { at: DECLARED_AT });
    return row;
  }
  const recordOf = async (row: LegalBodyRecord, d: LegalBodyPotDeps = deps()) =>
    potOfStatement(d, await statementOf(row));
  const answer = (raw: PotRaw) => chain.port.readPot.mockResolvedValue(raw);

  test("serves ceiling_read with the proof's numbers as decimal strings and the birth details, at the statement's block", async () => {
    const row = withV3();
    answer(HEALTHY);
    const stated = await statementOf(row);
    const block = await potOfStatement(deps(), stated);
    expect(block).toEqual({
      state: "ceiling_read",
      address: V3_ADDRESS,
      token: T.usdc,
      ceilingUnits: "50000000",
      periodMinutes: 43200,
      spentUnits: "10000000",
      periodEndsAt: (29919864 + 43200) * 60,
      balanceUnits: "190000000",
      ...V3_FACTS,
    });
    expect(Object.keys(block ?? {})).toEqual([
      "state",
      "address",
      "token",
      "ceilingUnits",
      "periodMinutes",
      "spentUnits",
      "periodEndsAt",
      "balanceUnits",
      "readAtBlock",
      "readAt",
      "declaredBy",
      "declaredAt",
      "birth",
    ]);
    expect(Object.keys((block as { birth: object }).birth)).toEqual([
      "guardian",
      "agentWallet",
      "token",
      "ceilingUnits",
      "periodMinutes",
      "saltNonce",
      "proxyFactory",
      "singleton",
      "fallbackHandler",
      "multiSendCallOnly",
      "allowanceModule",
    ]);
    // One read, at the statement's own block, against the agent's wallet the statement signs; the
    // block and the time it states are the statement's.
    expect(stated.statement.message.observedAtBlock).toBe("4242");
    expect(stated.statement.message.issuedAt).toBe(String(CLOCK_S));
    expect(chain.port.readPot.mock.calls).toEqual([
      [{ pot: V3_ADDRESS, agentWallet: A, blockNumber: BLOCK }],
    ]);
    expect(chain.port.codeHash).not.toHaveBeenCalled();
    expect(registry.getAgentWallet).not.toHaveBeenCalled();
    // Anyone recomputes the pot's address from the birth details served, and nothing else.
    const b = servedBirth();
    expect(
      potAddressOf({
        guardian: b.guardian,
        agentWallet: b.agentWallet,
        ceilingUnits: BigInt(b.ceilingUnits),
        saltNonce: BigInt(b.saltNonce),
      }),
    ).toBe(V3_ADDRESS);
    // A statement that is pending is in force too.
    const pending = pendingWithPot();
    expect((await statementOf(pending)).standing).toBe("pending");
    expect(await recordOf(pending)).toMatchObject({
      state: "ceiling_read",
      address: potOf(60n).address,
      ceilingUnits: "60000000",
    });
  });

  /** A body whose company is not paid for yet, with its own pot of 60 USDC noted: stated
   *  `pending`. */
  function pendingWithPot(): LegalBodyRecord {
    const row = statedPotBody(s, stChain, { agentId: "43", companyStatus: "draft" });
    const its = potOf(60n);
    notePot(pots, row, { at: DECLARED_AT, address: its.address, birth: its.birth });
    chain.port.readPot.mockResolvedValue({
      ...HEALTHY,
      allowance: [60_000_000n, 0n, 43200n, 1n, 0n],
    });
    return row;
  }

  test("serves stopped, with the balance, for the real Safe's answers after its stop (REAL_STOPPED)", async () => {
    const row = withV3();
    answer(REAL_STOPPED);
    const block = await recordOf(row);
    expect(block).toEqual({
      state: "stopped",
      address: V3_ADDRESS,
      balanceUnits: "0",
      ...V3_FACTS,
    });
    expect(Object.keys(block ?? {})).toEqual([
      "state",
      "address",
      "balanceUnits",
      "readAtBlock",
      "readAt",
      "declaredBy",
      "declaredAt",
      "birth",
    ]);
    // With money left in it; and with the key removed while the add-on is still on.
    answer({ ...REAL_STOPPED, balanceUnits: 3_000_000n });
    expect(await recordOf(row)).toEqual({
      state: "stopped",
      address: V3_ADDRESS,
      balanceUnits: "3000000",
      ...V3_FACTS,
    });
    answer({ ...HEALTHY, delegates: { list: [], next: 0 } });
    expect(await recordOf(row)).toEqual({
      state: "stopped",
      address: V3_ADDRESS,
      balanceUnits: "190000000",
      ...V3_FACTS,
    });
  });

  test("serves limits_not_read, with no amount, for another fallback handler, and for an approval to the agent's key", async () => {
    const row = withV3();
    for (const raw of [
      { ...HEALTHY, fallbackHandler: P },
      { ...HEALTHY, usdcAllowanceToAgent: 1n },
      // …and for a stopped pot with another add-on: never "stopped" past another add-on.
      { ...REAL_STOPPED, modules: { list: [P], next: REAL_STOPPED.modules.next } },
    ]) {
      answer(raw);
      const block = await recordOf(row);
      expect(block).toEqual({ state: "limits_not_read", address: V3_ADDRESS, ...V3_FACTS });
      expect(Object.keys(block ?? {})).toEqual([
        "state",
        "address",
        "readAtBlock",
        "readAt",
        "declaredBy",
        "declaredAt",
        "birth",
      ]);
    }
  });

  test("serves limits_not_read when the registry's wallet is no longer the pot's delegate", async () => {
    // The agent's key was replaced in the registry after the setup: the statement signs P, while
    // the pot's delegate is still A, its birth key.
    const row = withV3({ wallet: P });
    answer(HEALTHY);
    const stated = await statementOf(row);
    expect(stated.statement.message.agentWallet).toBe(P);
    expect(await potOfStatement(deps(), stated)).toEqual({
      state: "limits_not_read",
      address: V3_ADDRESS,
      ...V3_FACTS,
    });
    expect(chain.port.readPot.mock.calls).toEqual([
      [{ pot: V3_ADDRESS, agentWallet: P, blockNumber: BLOCK }],
    ]);
    expect(registry.getAgentWallet).not.toHaveBeenCalled();
  });

  test("serves null for a note whose address has no code (noted, never created), and after the pot was taken off the record", async () => {
    const row = withV3();
    answer({ ...HEALTHY, codeHash: null });
    expect(await recordOf(row)).toBeNull();
    expect(chain.port.readPot).toHaveBeenCalledTimes(1);
    // Code that is not a pot's proxy is not named either.
    answer({ ...HEALTHY, codeHash: SOME_CODE });
    expect(await recordOf(row)).toBeNull();
    // Taken off the record: null, and nothing read.
    chain.port.readPot.mockClear();
    notePot(pots, row, { at: DECLARED_AT + 60, act: "removed" });
    answer(HEALTHY);
    expect(await recordOf(row)).toBeNull();
    // A body with no note at all.
    expect(await recordOf(statedPotBody(s, stChain, { agentId: "43" }))).toBeNull();
    expectNoChainRead();
    // None of these is a note the doors did not write.
    expect(linesOf("legal_body_pot_note_unrecomputable")).toEqual([]);
  });

  test("serves null when the Safe has a second owner", async () => {
    const row = withV3();
    for (const raw of [
      { ...HEALTHY, owners: [G, P] },
      { ...HEALTHY, owners: [P] },
      { ...HEALTHY, threshold: 2n },
    ]) {
      answer(raw);
      expect(await recordOf(row), JSON.stringify(raw.owners)).toBeNull();
    }
  });

  test("serves null beside a statement whose standing is inactive, and reads no chain", async () => {
    const row = withV3({ status: "winding_down" });
    answer(HEALTHY);
    const stated = await statementOf(row);
    expect(stated.standing).toBe("inactive");
    expect(await potOfStatement(deps(), stated)).toBeNull();
    expectNoChainRead();
  });

  test("serves unavailable when the chain read throws, and lets a database error through", async () => {
    const row = withV3();
    chain.port.readPot.mockRejectedValue(nodeError());
    expect(await recordOf(row)).toEqual({ state: "unavailable" });
    expect(linesOf("legal_body_pot_unavailable")).toEqual([
      { legalBodyId: row.legalBodyId, errorName: "HttpRequestError" },
    ]);
    expect(printed.join("\n")).not.toContain("rpc.example");
    // A database read that fails throws: the routes answer it with their 503.
    const d = deps();
    vi.spyOn(d.repo, "latest").mockImplementation(() => {
      throw Object.assign(new Error("SQLITE_BUSY: database is locked"), { name: "SqliteError" });
    });
    await expect(potOfStatement(d, await statementOf(row))).rejects.toThrow("SQLITE_BUSY");
  });

  test("while the pot is not offered (Ruling R15 b): the pot is named with its birth details and its limits were not read; its state is not read, never a ceiling, never stopped", async () => {
    const row = withV3();
    offered = false;
    chain.codes.set(V3_ADDRESS.toLowerCase(), SAFE_PROXY_RUNTIME_CODE_HASH);
    for (const raw of [HEALTHY, REAL_STOPPED]) {
      answer(raw);
      chain.port.codeHash.mockClear();
      expect(await recordOf(row)).toEqual({
        state: "limits_not_read",
        address: V3_ADDRESS,
        ...V3_FACTS,
      });
      // Only whether the address holds a pot's proxy, at the statement's block.
      expect(chain.port.codeHash.mock.calls).toEqual([[V3_ADDRESS, BLOCK]]);
    }
    expect(chain.port.readPot).not.toHaveBeenCalled();
    // Noted and never created, or other code: not named.
    chain.codes.delete(V3_ADDRESS.toLowerCase());
    expect(await recordOf(row)).toBeNull();
    chain.codes.set(V3_ADDRESS.toLowerCase(), SOME_CODE);
    expect(await recordOf(row)).toBeNull();
    // The code read fails: unavailable.
    chain.port.codeHash.mockRejectedValueOnce(nodeError());
    expect(await recordOf(row)).toEqual({ state: "unavailable" });
    expect(chain.port.readPot).not.toHaveBeenCalled();
    // The flag on again: the pot is read in full, and its code is not read apart.
    offered = true;
    chain.port.codeHash.mockClear();
    answer(HEALTHY);
    expect(await recordOf(row)).toMatchObject({ state: "ceiling_read", ceilingUnits: "50000000" });
    expect(chain.port.readPot).toHaveBeenCalledTimes(1);
    expect(chain.port.codeHash).not.toHaveBeenCalled();
  });

  test("no deps: null; a note whose birth details do not give its address is never read (written around the door)", async () => {
    const row = statedPotBody(s, stChain);
    expect(await potOfStatement(undefined, await statementOf(row))).toBeNull();
    // V3's address with another salt in its birth details.
    notePot(pots, row, { at: DECLARED_AT, birth: { ...BIRTH_V3, saltNonce: "2" } });
    answer(HEALTHY);
    expect(await recordOf(row)).toBeNull();
    // Another guardian's pot with V3's birth details, on G's body.
    const other = statedPotBody(s, stChain, { agentId: "43" });
    notePot(pots, other, {
      at: DECLARED_AT,
      address: potAddressOf({ guardian: P, ceilingUnits: 50_000_000n }),
    });
    expect(await recordOf(other)).toBeNull();
    expectNoChainRead();
    expect(linesOf("legal_body_pot_note_unrecomputable")).toEqual([
      { level: "error", legalBodyId: row.legalBodyId },
      { level: "error", legalBodyId: other.legalBodyId },
    ]);
  });
});

describe("the lookup by a pot's address (statementForPotAddress)", () => {
  let stChain: FakeStatementChain;
  beforeEach(() => {
    stChain = new FakeStatementChain();
  });

  const lookup = (address: Address, d: LegalBodyPotDeps = deps()) =>
    statementForPotAddress(statementDeps(s, stChain), d, address);
  const NONE = { outcome: { kind: "none" }, pot: null };
  const proxyAt = (address: Address) =>
    chain.codes.set(address.toLowerCase(), SAFE_PROXY_RUNTIME_CODE_HASH);

  test("finds the body by its current pot; refuses a candidate whose reading is not_the_guardians; reads nothing with no candidate", async () => {
    const row = statedPotBody(s, stChain);
    notePot(pots, row, { at: DECLARED_AT });
    chain.port.readPot.mockResolvedValue(HEALTHY);
    const found = await lookup(V3_ADDRESS.toLowerCase() as Address);
    expect(found.outcome).toMatchObject({
      kind: "statement",
      legalBodyId: row.legalBodyId,
      agentId: "42",
      standing: "active",
    });
    expect(found.pot).toEqual({
      state: "ceiling_read",
      address: V3_ADDRESS,
      token: T.usdc,
      ceilingUnits: "50000000",
      periodMinutes: 43200,
      spentUnits: "10000000",
      periodEndsAt: (29919864 + 43200) * 60,
      balanceUnits: "190000000",
      ...V3_FACTS,
    });
    // The pot's state read once, at the statement's block; its code not read apart.
    expect(chain.port.readPot.mock.calls).toEqual([
      [{ pot: V3_ADDRESS, agentWallet: A, blockNumber: BLOCK }],
    ]);
    expect(chain.port.codeHash).not.toHaveBeenCalled();
    // A Safe that is not the guardian's alone leads nowhere.
    chain.port.readPot.mockResolvedValue({ ...HEALTHY, owners: [G, P] });
    expect(await lookup(V3_ADDRESS)).toEqual(NONE);
    // An address nobody noted: no chain read of any kind.
    stChain.snapshots.length = 0;
    stChain.codeReads.length = 0;
    chain.port.readPot.mockClear();
    expect(await lookup(potOf(70n).address)).toEqual(NONE);
    expect(stChain.snapshots).toEqual([]);
    expect(stChain.codeReads).toEqual([]);
    expectNoChainRead();
  });

  test("a pot taken off the record, or replaced by a later note, is former with its declared and ended times, after one code read", async () => {
    const row = statedPotBody(s, stChain);
    notePot(pots, row, { at: DECLARED_AT });
    notePot(pots, row, { at: DECLARED_AT + 600, act: "removed" });
    proxyAt(V3_ADDRESS);
    const off = await lookup(V3_ADDRESS);
    expect(off.outcome).toMatchObject({ kind: "statement", legalBodyId: row.legalBodyId });
    expect(off.pot).toEqual({
      state: "former",
      address: V3_ADDRESS,
      declaredBy: "guardian",
      declaredAt: DECLARED_AT,
      endedAt: DECLARED_AT + 600,
      birth: servedBirth(),
    });
    expect(Object.keys(off.pot ?? {})).toEqual([
      "state",
      "address",
      "declaredBy",
      "declaredAt",
      "endedAt",
      "birth",
    ]);
    expect(chain.port.codeHash.mock.calls).toEqual([[V3_ADDRESS, BLOCK]]);
    expect(chain.port.readPot).not.toHaveBeenCalled();
    // Put back, then taken off again: the times of its latest declaration.
    notePot(pots, row, { at: DECLARED_AT + 1_200 });
    notePot(pots, row, { at: DECLARED_AT + 1_800, act: "removed" });
    expect((await lookup(V3_ADDRESS)).pot).toMatchObject({
      state: "former",
      declaredAt: DECLARED_AT + 1_200,
      endedAt: DECLARED_AT + 1_800,
    });

    // Another body's first pot X, replaced by Y: X is former, ended when Y was noted.
    const other = statedPotBody(s, stChain, { agentId: "43" });
    const x = potOf(60n);
    const y = potOf(70n);
    notePot(pots, other, { at: DECLARED_AT, address: x.address, birth: x.birth });
    notePot(pots, other, { at: DECLARED_AT + 300, address: y.address, birth: y.birth });
    proxyAt(x.address);
    chain.port.codeHash.mockClear();
    const replaced = await lookup(x.address);
    expect(replaced.outcome).toMatchObject({
      kind: "statement",
      legalBodyId: other.legalBodyId,
      agentId: "43",
    });
    expect(replaced.pot).toEqual({
      state: "former",
      address: x.address,
      declaredBy: "guardian",
      declaredAt: DECLARED_AT,
      endedAt: DECLARED_AT + 300,
      birth: servedBirth(x.birth),
    });
    expect(chain.port.codeHash.mock.calls).toEqual([[x.address, BLOCK]]);
    // Y taken off since: X still ended when Y was noted, not at the latest note.
    notePot(pots, other, { at: DECLARED_AT + 900, act: "removed", address: y.address });
    expect((await lookup(x.address)).pot).toMatchObject({
      state: "former",
      declaredAt: DECLARED_AT,
      endedAt: DECLARED_AT + 300,
    });
    // A former pot that never got its code leads nowhere.
    chain.codes.delete(x.address.toLowerCase());
    expect(await lookup(x.address)).toEqual(NONE);
    // A failed code read: kept, unavailable.
    chain.port.codeHash.mockRejectedValueOnce(nodeError());
    expect(await lookup(x.address)).toMatchObject({
      outcome: { kind: "statement", legalBodyId: other.legalBodyId },
      pot: { state: "unavailable" },
    });
    expect(chain.port.readPot).not.toHaveBeenCalled();
  });

  test("the pot of an inactive body leads to its statement with pot null; a statement about another body of the same agent is not kept", async () => {
    const row = statedPotBody(s, stChain, { status: "winding_down" });
    notePot(pots, row, { at: DECLARED_AT });
    proxyAt(V3_ADDRESS);
    const found = await lookup(V3_ADDRESS);
    expect(found.outcome).toMatchObject({
      kind: "statement",
      legalBodyId: row.legalBodyId,
      standing: "inactive",
    });
    expect(found.pot).toBeNull();
    expect(chain.port.codeHash.mock.calls).toEqual([[V3_ADDRESS, BLOCK]]);
    expect(chain.port.readPot).not.toHaveBeenCalled();
    // No pot's code at the address: it leads nowhere.
    chain.codes.delete(V3_ADDRESS.toLowerCase());
    expect(await lookup(V3_ADDRESS)).toEqual(NONE);
    // A failed code read: kept, unavailable.
    chain.port.codeHash.mockRejectedValueOnce(nodeError());
    expect(await lookup(V3_ADDRESS)).toMatchObject({
      outcome: { kind: "statement", legalBodyId: row.legalBodyId },
      pot: { state: "unavailable" },
    });

    // The agent's older body noted X; the agent's current body is another: the statement made for
    // the agent is about the current body, so it is not the older body's answer.
    const older = statedPotBody(s, stChain, { agentId: "44" });
    const x = potOf(60n);
    notePot(pots, older, { at: DECLARED_AT, address: x.address, birth: x.birth });
    const current = statedPotBody(s, stChain, { agentId: "44" });
    expect(current.legalBodyId).not.toBe(older.legalBodyId);
    proxyAt(x.address);
    chain.port.codeHash.mockClear();
    expect(await lookup(x.address)).toEqual(NONE);
    expect(chain.port.codeHash).not.toHaveBeenCalled();
    expect(chain.port.readPot).not.toHaveBeenCalled();
  });

  test("a statement that cannot be made just now ends the search: unknown, pot null; of two bodies holding the address, the active one is answered", async () => {
    const row = statedPotBody(s, stChain);
    notePot(pots, row, { at: DECLARED_AT });
    chain.port.readPot.mockResolvedValue(HEALTHY);
    stChain.beforeSnapshot = () => {
      throw nodeError();
    };
    expect(await lookup(V3_ADDRESS)).toEqual({
      outcome: { kind: "unknown", agentId: "42", stage: "snapshot", errorName: "HttpRequestError" },
      pot: null,
    });
    expect(chain.port.readPot).not.toHaveBeenCalled();
    stChain.beforeSnapshot = () => {};

    // Two bodies noted the same address, written around the door: the newest note's body is
    // inactive, the other active. The active one is answered.
    const inactive = statedPotBody(s, stChain, { agentId: "43", status: "winding_down" });
    notePot(pots, inactive, { at: DECLARED_AT + 60 });
    proxyAt(V3_ADDRESS);
    const found = await lookup(V3_ADDRESS);
    expect(found.outcome).toMatchObject({ kind: "statement", legalBodyId: row.legalBodyId });
    expect(found.pot).toMatchObject({ state: "ceiling_read", address: V3_ADDRESS });
    // The newest note's body cannot be stated just now: the search ends there, and the other body
    // is not read.
    const failAt = stChain.snapshots.length + 1;
    stChain.beforeSnapshot = (n) => {
      if (n === failAt) throw nodeError();
    };
    chain.port.readPot.mockClear();
    expect(await lookup(V3_ADDRESS)).toEqual({
      outcome: { kind: "unknown", agentId: "43", stage: "snapshot", errorName: "HttpRequestError" },
      pot: null,
    });
    expect(stChain.snapshots).toHaveLength(failAt);
    expect(chain.port.readPot).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// The agent's two tools: what is left, and a take for the agent's own key to send
// ---------------------------------------------------------------------------------------------

/** The Safe the real run of 24 Nov created: V7's pot. Its birth details are the run's (a
 *  five-minute period, which no note door takes and the server's recompute never gives): a note of
 *  it is one the server did not recompute, so it is never read. */
const REAL_SAFE: Address = "0x0bbBa174c1D6b6Edd2F1A86ff5af435B645b77EF";
const REAL_SAFE_BIRTH: PotBirthNote = {
  saltNonce: "72231338869903870587851170785833461215",
  agentWallet: A,
  ceilingUnits: "2000000",
};
/** keccak256 of V7: the agent's take the real run mined (the real Safe, USDC, P, 1 USDC, A, an
 *  empty signature). */
const V7_HASH = "0xdfe8f8bded62c4439e5dc86fdb9f39258afb89a2a0c10a65383c15ae626c24ec";
const MODULE: Address = "0xAA46724893dedD72658219405185Fb0Fc91e091C";
/** The take of 1 USDC to P from V3, for the agent A: the bytes the encoder pinned to V7 builds. */
const V3_TAKE = takeCalldata({
  pot: V3_ADDRESS,
  token: T.usdc,
  to: P,
  amountUnits: 1_000_000n,
  agentWallet: A,
});

describe("the agent's pot: what is left (potForAgent) and a take to send (prepareTake)", () => {
  /** A linked body of G whose registry names A, with `address` (V3 unless told) noted an hour
   *  ago, with `birth` (V3's unless told). */
  function withPot(o: { address?: Address; birth?: PotBirthNote } = {}): LegalBodyRecord {
    const row = linked();
    notePot(pots, row, {
      at: NOW_S - 3_600,
      address: o.address ?? V3_ADDRESS,
      birth: o.birth ?? BIRTH_V3,
    });
    return row;
  }
  const answer = (raw: PotRaw) => chain.port.readPot.mockResolvedValue(raw);
  const take = (row: LegalBodyRecord, input: { to: unknown; amountUnits: unknown }) =>
    prepareTake(deps(), G, row.legalBodyId, input);
  const read = (row: LegalBodyRecord, d: LegalBodyPotDeps = deps()) =>
    potForAgent(d, G, row.legalBodyId);
  /** The pot's notes and the body's events, to show that a call wrote nothing. */
  const written = (row: LegalBodyRecord) => ({
    notes: rows(),
    events: s.repo.listEvents(row.legalBodyId),
  });

  test("prepares the take with the encoder the real run's mined take (V7) pins: to the module, value 0, gas 200000, an empty signature", async () => {
    // The encoder gives V7's mined bytes for the real Safe (pinned at its own level, safePot.test.ts).
    expect(
      keccak256(
        takeCalldata({
          pot: REAL_SAFE,
          token: T.usdc,
          to: P,
          amountUnits: 1_000_000n,
          agentWallet: A,
        }),
      ),
    ).toBe(V7_HASH);
    // The pot here is V3, which the server recomputes: the thirty-day initializer, salt 1. It reads
    // HEALTHY (a ceiling of 50, 10 taken); the agent A, the payee P, 1000000 units.
    const row = withPot();
    answer(HEALTHY);
    const before = written(row);
    const t = await take(row, { to: P, amountUnits: "1000000" });
    expect(t.data).toBe(V3_TAKE);
    expect(size(t.data)).toBe(292);
    expect(t).toEqual({
      chainId: 5_042_002,
      from: A,
      to: MODULE,
      value: "0",
      data: V3_TAKE,
      gas: "200000",
      leftAfterUnits: "39000000",
      how: LEGAL_BODY_SENTENCES.pot_take_how,
      warning: null,
    });
    expect(Object.keys(t)).toEqual([
      "chainId",
      "from",
      "to",
      "value",
      "data",
      "gas",
      "leftAfterUnits",
      "how",
      "warning",
    ]);
    // The take of the module: the pot, USDC, the payee, the amount, no payment token and no
    // payment, the agent's own key as the delegate, and an empty signature: the module takes the
    // sender as the signer.
    const { functionName, args } = decodeFunctionData({ abi: allowanceModuleAbi, data: t.data });
    expect(functionName).toBe("executeAllowanceTransfer");
    expect(args).toEqual([V3_ADDRESS, T.usdc, P, 1_000_000n, zeroAddress, 0n, A, "0x"]);
    // The payee in lower case gives the same bytes.
    expect((await take(row, { to: P.toLowerCase(), amountUnits: "1000000" })).data).toBe(t.data);
    // One registry read for the body's agent, then one read of the pot against that wallet: the
    // port reads all of it at one fresh block, as no block is asked. No code read, nothing written.
    expect(registry.getAgentWallet.mock.calls[0]).toEqual([BigInt(row.agentId as string)]);
    expect(chain.port.readPot.mock.calls[0]).toEqual([{ pot: V3_ADDRESS, agentWallet: A }]);
    expect(chain.port.codeHash).not.toHaveBeenCalled();
    expect(written(row)).toEqual(before);
  });

  test("a note whose birth details do not give its address is never read: 500 internal_error for both, after one error line (Ruling R18)", async () => {
    answer(HEALTHY);
    // The real Safe, noted with the run's birth details: a five-minute period, which the server's
    // recompute never gives. And V3's address noted with another salt.
    const real = withPot({ address: REAL_SAFE, birth: REAL_SAFE_BIRTH });
    const salted = withPot({ birth: { ...BIRTH_V3, saltNonce: "2" } });
    for (const row of [real, salted]) {
      for (const run of [() => read(row), () => take(row, { to: P, amountUnits: "1000000" })])
        expect(await refusalOf(run)).toMatchObject(refused("internal_error", 500));
    }
    expectNoChainRead();
    expect(linesOf("legal_body_pot_note_unrecomputable")).toEqual([
      { level: "error", legalBodyId: real.legalBodyId },
      { level: "error", legalBodyId: real.legalBodyId },
      { level: "error", legalBodyId: salted.legalBodyId },
      { level: "error", legalBodyId: salted.legalBodyId },
    ]);
    // The address V3's birth details give for another guardian, noted on G's body: recomputed with
    // the body's own guardian, it does not come out either.
    const other = withPot({ address: potAddressOf({ guardian: P, ceilingUnits: 50_000_000n }) });
    expect(await refusalOf(() => read(other))).toMatchObject(refused("internal_error", 500));
    expectNoChainRead();
  });

  test("refuses pot_take_body_not_in_force for a revoked body and a body not linked, before any chain read; get_pot still answers for them (Ruling R17)", async () => {
    answer(HEALTHY);
    const revoked = withPot();
    s.repo.recordEvent(revoked.legalBodyId, "revoked", "operator:ops.example", null, {
      reason: "Recorded for a test.",
    });
    const broken = withPot();
    expect(s.repo.markBroken(broken.legalBodyId, { reason: "a test" })).toBe(true);
    const superseded = withPot();
    expect(s.repo.markBroken(superseded.legalBodyId, { reason: "a test" })).toBe(true);
    expect(s.repo.supersede(superseded.legalBodyId, revoked.legalBodyId)).toBe(true);
    const deployed = potBody(s, { nowMs: clock, state: "deployed" });
    registry.wallets.set(deployed.agentId as string, A);
    notePot(pots, deployed, { at: NOW_S - 3_600 });
    // A draft abandoned, with a note written straight into the record: no door makes one.
    const companyId = customerCompany(s, G, { filingNumber: "TEST-P9001" });
    const draft = s.repo.create({
      tenantId: G,
      companyId,
      chainId: CHAIN_ID,
      factory: FACTORY,
      amendmentDelay: 172_800,
    });
    expect(s.repo.abandon(draft.legalBodyId, "a test")).toBe(true);
    notePot(pots, draft, { at: NOW_S - 3_600 });

    const states: [LegalBodyRecord, string][] = [
      [revoked, "linked"],
      [broken, "broken"],
      [superseded, "superseded"],
      [deployed, "deployed"],
      [draft, "abandoned"],
    ];
    for (const [row, state] of states) {
      expect(s.repo.findById(row.legalBodyId)?.bindingState, state).toBe(state);
      expect(
        await refusalOf(() => take(row, { to: P, amountUnits: "1000000" })),
        state,
      ).toMatchObject(refused("pot_take_body_not_in_force", 409));
    }
    expectNoChainRead();
    // The read answers for a body in any state that has its agent.
    for (const row of [revoked, broken, superseded, deployed])
      expect(await read(row)).toMatchObject({ pot: V3_ADDRESS, state: "ceiling_read" });
    // A linked body that was not revoked: the take is prepared.
    expect(await take(withPot(), { to: P, amountUnits: "1000000" })).toMatchObject({
      data: V3_TAKE,
    });
  });

  test("refuses pot_take_bad_payee for the pot itself, the USDC token and the AllowanceModule, in any letter case, before any chain read", async () => {
    answer(HEALTHY);
    const row = withPot();
    for (const payee of [
      V3_ADDRESS,
      V3_ADDRESS.toLowerCase(),
      T.usdc,
      MODULE,
      MODULE.toLowerCase(),
    ])
      expect(
        await refusalOf(() => take(row, { to: payee, amountUnits: "1" })),
        payee,
      ).toMatchObject(refused("pot_take_bad_payee", 409));
    expectNoChainRead();
    // The agent's own address is a payee like any other.
    expect(await take(row, { to: A, amountUnits: "1" })).toMatchObject({
      leftAfterUnits: "39999999",
    });
  });

  test("refuses pot_take_over_ceiling for 40000001 units when 40000000 are left, and accepts exactly 40000000", async () => {
    const row = withPot();
    answer(HEALTHY);
    expect(await refusalOf(() => take(row, { to: P, amountUnits: "40000001" }))).toMatchObject(
      refused("pot_take_over_ceiling", 409),
    );
    expect(await take(row, { to: P, amountUnits: "40000000" })).toMatchObject({
      leftAfterUnits: "0",
      warning: null,
    });
    // A ceiling lowered under what was taken in the current period leaves nothing: one unit is
    // over it, and the read says 0 are left.
    answer({ ...HEALTHY, allowance: [5_000_000n, 10_000_000n, 43200n, 29919864n, 2n] });
    expect(await refusalOf(() => take(row, { to: P, amountUnits: "1" }))).toMatchObject(
      refused("pot_take_over_ceiling", 409),
    );
    expect(await read(row)).toMatchObject({ leftUnits: "0", spentUnits: "10000000" });
  });

  test("refuses pot_take_over_balance when the pot holds less than the amount; the ceiling is judged first", async () => {
    const row = withPot();
    answer({ ...HEALTHY, balanceUnits: 999_999n });
    expect(await refusalOf(() => take(row, { to: P, amountUnits: "1000000" }))).toMatchObject(
      refused("pot_take_over_balance", 409),
    );
    expect(await take(row, { to: P, amountUnits: "999999" })).toMatchObject({
      leftAfterUnits: "39000001",
    });
    // Above both: the ceiling's refusal.
    expect(await refusalOf(() => take(row, { to: P, amountUnits: "40000001" }))).toMatchObject(
      refused("pot_take_over_ceiling", 409),
    );
  });

  test("refuses pot_take_invalid for amount '0', '1.5', 1000000 as a number, to the zero address, to 'P' with a wrong checksum", async () => {
    const row = withPot();
    answer(HEALTHY);
    // P with its first letter in the wrong case: mixed case that is not the checksum.
    const wrongChecksum = `0xe${P.slice(3)}`;
    expect(wrongChecksum.toLowerCase()).toBe(P.toLowerCase());
    expect(wrongChecksum).not.toBe(P);
    const inputs: { to: unknown; amountUnits: unknown }[] = [
      { to: P, amountUnits: "0" },
      { to: P, amountUnits: "1.5" },
      { to: P, amountUnits: 1_000_000 },
      { to: zeroAddress, amountUnits: "1000000" },
      { to: wrongChecksum, amountUnits: "1000000" },
      { to: "P", amountUnits: "1000000" },
      { to: P, amountUnits: "01000000" },
      { to: P, amountUnits: "-1" },
      { to: P, amountUnits: " 1000000" },
      { to: P, amountUnits: (2n ** 96n).toString() },
      { to: P, amountUnits: undefined },
      { to: undefined, amountUnits: "1000000" },
      { to: P.slice(0, 41), amountUnits: "1000000" },
    ];
    for (const input of inputs)
      expect(await refusalOf(() => take(row, input)), JSON.stringify(input)).toMatchObject(
        refused("pot_take_invalid", 400),
      );
    // Judged before the registry and the pot are read: an invalid take costs no chain read.
    expectNoChainRead();
    // The largest amount the module takes is a valid amount: here it is above the ceiling.
    expect(
      await refusalOf(() => take(row, { to: P, amountUnits: (2n ** 96n - 1n).toString() })),
    ).toMatchObject(refused("pot_take_over_ceiling", 409));
    // An address in lower case is taken.
    expect(await take(row, { to: P.toLowerCase(), amountUnits: "1" })).toMatchObject({
      leftAfterUnits: "39999999",
    });
  });

  test("refuses pot_not_readable when the pot is stopped, though the module still shows an allowance", async () => {
    const row = withPot();
    const states: [PotRaw, string][] = [
      // The module switched off: the module's own answers still show the key and a live-looking
      // allowance (seen in the proof).
      [{ ...HEALTHY, modules: { list: [], next: SAFE_SENTINEL } }, "stopped"],
      // The key removed while the add-on is on.
      [{ ...HEALTHY, delegates: { list: [], next: 0 } }, "stopped"],
      // Something the reading does not read past: another fallback handler.
      [{ ...HEALTHY, fallbackHandler: P }, "limits_not_read"],
      // No code at the address: the Safe was noted, never created.
      [{ ...HEALTHY, codeHash: null }, "absent"],
      // A second owner.
      [{ ...HEALTHY, owners: [G, P] }, "not_the_guardians"],
    ];
    for (const [raw, state] of states) {
      answer(raw);
      expect((await read(row)).state, state).toBe(state);
      expect(
        await refusalOf(() => take(row, { to: P, amountUnits: "1000000" })),
        state,
      ).toMatchObject(refused("pot_not_readable", 409));
    }
    // The registry names a new key, which the pot's allowance does not name yet: its limits are
    // not read for that key, and no take is prepared for it.
    answer(HEALTHY);
    registry.wallets.set(row.agentId as string, P);
    expect(await read(row)).toMatchObject({ state: "limits_not_read", agentWallet: P });
    expect(chain.port.readPot.mock.calls.at(-1)).toEqual([{ pot: V3_ADDRESS, agentWallet: P }]);
    expect(await refusalOf(() => take(row, { to: P, amountUnits: "1" }))).toMatchObject(
      refused("pot_not_readable", 409),
    );
  });

  test("refuses pot_not_declared with no note, before any chain read, whatever the take", async () => {
    const row = linked();
    for (const run of [
      () => read(row),
      () => take(row, { to: P, amountUnits: "1000000" }),
      () => take(row, { to: zeroAddress, amountUnits: "0" }),
    ])
      expect(await refusalOf(run)).toMatchObject(refused("pot_not_declared", 409));
    expectNoChainRead();
  });

  test("warns pot_take_low_fee_money when the agent's key holds 0 wei, and when it holds 9999999999999999; not at 10000000000000000; still prepares the take", async () => {
    expect(POT_FEE_LOW_WEI).toBe(10_000_000_000_000_000n);
    const row = withPot();
    const cases: [bigint, string | null][] = [
      [0n, LEGAL_BODY_SENTENCES.pot_take_low_fee_money as string],
      [9_999_999_999_999_999n, LEGAL_BODY_SENTENCES.pot_take_low_fee_money as string],
      [10_000_000_000_000_000n, null],
    ];
    for (const [agentBalanceWei, warning] of cases) {
      answer({ ...HEALTHY, agentBalanceWei });
      const t = await take(row, { to: P, amountUnits: "1000000" });
      expect(t.warning, String(agentBalanceWei)).toBe(warning);
      expect(t.data).toBe(V3_TAKE);
      expect(await read(row)).toMatchObject({ agentKeyBalanceWei: agentBalanceWei.toString() });
    }
  });

  test("potForAgent: leftUnits is the ceiling less what was taken; amounts are absent unless ceiling_read; a stopped pot carries its balance; onRecord follows the latest note", async () => {
    const row = withPot({ address: V3_ADDRESS });
    const facts = {
      chainId: 5_042_002,
      pot: V3_ADDRESS,
      onRecord: true,
      agentWallet: A,
      module: MODULE,
      token: T.usdc,
    };
    answer(HEALTHY);
    const ceiling = await read(row);
    expect(ceiling).toEqual({
      ...facts,
      state: "ceiling_read",
      ceilingUnits: "50000000",
      spentUnits: "10000000",
      leftUnits: "40000000",
      periodEndsAt: (29919864 + 43200) * 60,
      balanceUnits: "190000000",
      agentKeyBalanceWei: "100000000000000000",
    });
    expect(Object.keys(ceiling)).toEqual([
      "chainId",
      "pot",
      "onRecord",
      "agentWallet",
      "module",
      "token",
      "state",
      "ceilingUnits",
      "spentUnits",
      "leftUnits",
      "periodEndsAt",
      "balanceUnits",
      "agentKeyBalanceWei",
    ]);

    // The real Safe after its stop: stopped, with its balance and the key's fee money only.
    answer(REAL_STOPPED);
    expect(await read(row)).toEqual({
      ...facts,
      state: "stopped",
      balanceUnits: "0",
      agentKeyBalanceWei: "294000000000000",
    });
    // Limits not read, and a Safe not the guardian's alone: no amount at all.
    answer({ ...HEALTHY, fallbackHandler: P });
    expect(await read(row)).toEqual({
      ...facts,
      state: "limits_not_read",
      agentKeyBalanceWei: "100000000000000000",
    });
    answer({ ...HEALTHY, threshold: 2n });
    expect(await read(row)).toEqual({
      ...facts,
      state: "not_the_guardians",
      agentKeyBalanceWei: "100000000000000000",
    });
    // No pot's code at the address: the read stops at the code, so the key's fee money was not
    // read, and none is stated.
    answer({ ...HEALTHY, codeHash: null });
    expect(await read(row)).toEqual({ ...facts, state: "absent", agentKeyBalanceWei: null });
    answer({ ...HEALTHY, codeHash: SOME_CODE });
    expect(await read(row)).toEqual({
      ...facts,
      state: "not_the_guardians",
      agentKeyBalanceWei: null,
    });

    // Taken off the public record, the pot still answers, and a take is still prepared: the record
    // does not matter to a take.
    answer(HEALTHY);
    clock += 60_000;
    removePot(deps(), G, row.legalBodyId);
    expect(await read(row)).toEqual({ ...ceiling, onRecord: false });
    expect(await take(row, { to: P, amountUnits: "1000000" })).toMatchObject({
      leftAfterUnits: "39000000",
    });
    // Put back, it is on the record again.
    clock += 60_000;
    await declare(row, V3_INPUT);
    expect(await read(row)).toEqual(ceiling);
  });

  test("the pot read is the latest note's address, replaced or not", async () => {
    const row = withPot({ address: V3_ADDRESS });
    const second = potOf(60n);
    notePot(pots, row, { at: NOW_S, address: second.address, birth: second.birth });
    answer({ ...HEALTHY, allowance: [60_000_000n, 0n, 43200n, 29919864n, 0n] });
    expect(await read(row)).toMatchObject({
      pot: second.address,
      state: "ceiling_read",
      leftUnits: "60000000",
    });
    expect(chain.port.readPot.mock.calls).toEqual([[{ pot: second.address, agentWallet: A }]]);
  });

  test("while the pot is not offered: pot_not_offered for both, before anything is read", async () => {
    const row = withPot();
    answer(HEALTHY);
    offered = false;
    for (const run of [() => read(row), () => take(row, { to: P, amountUnits: "1000000" })])
      expect(await refusalOf(run)).toMatchObject(refused("pot_not_offered", 409));
    expectNoChainRead();
    offered = true;
    expect(await read(row)).toMatchObject({ state: "ceiling_read" });
  });

  test("one 404 for another tenant's body and for an unknown id, and no chain read", async () => {
    const row = withPot();
    answer(HEALTHY);
    for (const [tenant, id] of [
      [STRANGER, row.legalBodyId],
      [G, `lb_${"0".repeat(36)}`],
    ] as const) {
      expect(await refusalOf(() => potForAgent(deps(), tenant, id))).toMatchObject(
        refused("not_found", 404),
      );
      expect(
        await refusalOf(() => prepareTake(deps(), tenant, id, { to: P, amountUnits: "1" })),
      ).toMatchObject(refused("not_found", 404));
    }
    expectNoChainRead();
  });

  test("a chain without a pot table is pot_chain_unsupported, before any chain read", async () => {
    const row = withPot();
    expect(await refusalOf(() => read(row, deps({ chainId: 1 })))).toMatchObject(
      refused("pot_chain_unsupported", 409),
    );
    expectNoChainRead();
  });

  test("a failed read of the registry or of the pot is 503 chain_unavailable, with no node text in the log, and nothing is written", async () => {
    const row = withPot();
    answer(HEALTHY);
    const before = written(row);
    registry.getAgentWallet.mockRejectedValueOnce(nodeError());
    expect(await refusalOf(() => take(row, { to: P, amountUnits: "1" }))).toMatchObject(
      refused("chain_unavailable", 503),
    );
    expect(chain.port.readPot).not.toHaveBeenCalled();
    chain.port.readPot.mockRejectedValueOnce(nodeError());
    expect(await refusalOf(() => read(row))).toMatchObject(refused("chain_unavailable", 503));
    expect(linesOf("legal_body_chain_unavailable")).toEqual([
      {
        level: "warn",
        orderId: row.legalBodyId,
        stage: "pot_agent_wallet",
        errorName: "HttpRequestError",
      },
      {
        level: "warn",
        orderId: row.legalBodyId,
        stage: "pot_read",
        errorName: "HttpRequestError",
      },
    ]);
    expect(printed.join("\n")).not.toContain("rpc.example");
    expect(written(row)).toEqual(before);
  });

  test("nothing here holds a key, signs or sends: the module only builds bytes and reads", () => {
    const text = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "legalBody", "pot.ts"),
      "utf8",
    );
    expect(text).not.toMatch(
      /sendTransaction|sendRawTransaction|signTransaction|signMessage|signTypedData|writeContract|privateKeyToAccount|WalletClient|mnemonic/,
    );
  });
});

describe("the words of the record", () => {
  const source = (...parts: string[]) =>
    readFileSync(join(import.meta.dirname, "..", "..", "src", ...parts), "utf8");

  test("the pot's record and its two routes never say enforced, guarantee or 'no key may take', and count the pot in fixed thirty-day periods", () => {
    // Each file with its comments' line breaks joined, so a phrase split over two lines is read.
    const unwrapped = (text: string) => text.replace(/\n\s*(?:\/\/|\*)\s*/g, " ");
    const files = {
      pot: unwrapped(source("legalBody", "pot.ts")),
      byAgent: unwrapped(source("api", "routes", "legalBodyStatements.ts")),
      byAddress: unwrapped(source("api", "routes", "legalBodies.ts")),
      orders: unwrapped(source("api", "routes", "legalBodyOrders.ts")),
    };
    for (const [name, text] of Object.entries(files))
      expect(text, name).not.toMatch(/enforced|guarantee|no key may take|per thirty days/i);
    // The words the record's states stand for, and the comments' own.
    expect(files.pot).toContain(
      "The agent's key cannot take from it: its allowance is switched off.",
    );
    expect(files.pot).toContain("Its limits were not read.");
    expect(files.pot).toContain("in each thirty-day period");
    expect(files.pot).not.toContain("\u2014");
    for (const name of ["pot", "byAgent", "byAddress"] as const) {
      expect(files[name], name).toMatch(/read from the chain/);
      expect(files[name], name).toMatch(/periods are fixed/);
    }
    // The off-record door's comment, and its domain function's, say why it takes no flag.
    for (const name of ["orders", "pot"] as const)
      expect(files[name], name).toContain(
        "Unlike the abandon door, no deployment check and no flag: a guardian may always withdraw a claim.",
      );
  });
});
