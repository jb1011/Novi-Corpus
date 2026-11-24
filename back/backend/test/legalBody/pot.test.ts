/**
 * The company's pot, noted before the transaction: the guardian's wallet sends the pot's setup only
 * after the server has noted its address, and the server notes it only after recomputing it itself
 * from the birth details (the salt, the ceiling, the agent's key the registry names, the guardian),
 * with the guardian's declaration stored in the note and in the body's event log. One pot for life.
 *
 * The domain over a real in-memory database, a fake registry and a fake chain port, on a fixed
 * clock. Each body is placed through the order door's own domain function, so its agreement and
 * its grant read back as a real order's do. G, A and P are the real run's public addresses, never a
 * key; V3 is the pinned vector. Every other address is a placeholder.
 */
import { type Address, getAddress, zeroAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../src/errors";
import type { GrantChoices } from "../../src/legalBody/grant";
import {
  type LegalBodyPotDeps,
  POT_DECLARATION,
  declarePot,
  orderPot,
} from "../../src/legalBody/pot";
import { POT_CEILING_MAX_USDC } from "../../src/legalBody/safePot";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteLegalBodyPotRepository } from "../../src/persistence/legalBodyPotRepository";
import type { LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import { A as GRANT_A } from "../helpers/grantFixtures";
import { type LegalBodyStores, openLegalBodyStores } from "../helpers/legalBodyFixtures";
import {
  A,
  G,
  NO_SPENDING,
  P,
  SOME_CODE,
  V3_ADDRESS,
  V3_INPUT,
  fakePotChain,
  fakeRegistry,
  inputFor,
  potAddressOf,
  potBody,
  potDeps,
} from "../helpers/potFixtures";

/** The clock: 2026-11-24T12:00:00Z. */
const NOW_MS = Date.parse("2026-11-24T12:00:00.000Z");
const NOW_S = NOW_MS / 1000;
/** anvil's published account #2's address: another tenant, never a real wallet. */
const STRANGER: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

let s: LegalBodyStores;
let pots: SqliteLegalBodyPotRepository;
let clock: number;
let registry: ReturnType<typeof fakeRegistry>;
let chain: ReturnType<typeof fakePotChain>;
let offered: boolean;
let printed: string[];

beforeEach(() => {
  const db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  pots = new SqliteLegalBodyPotRepository(db);
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

const BIRTH_V3 = { saltNonce: "1", agentWallet: A, ceilingUnits: "50000000" };

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

  test("while the pot is not offered: pot_not_offered for both, before anything is read", async () => {
    const body = linked();
    offered = false;
    const findOwned = vi.spyOn(s.repo, "findOwned");
    expect(await refusalOf(() => declare(body, V3_INPUT))).toMatchObject(
      refused("pot_not_offered", 409),
    );
    expect(await refusalOf(() => orderPot(deps(), G, body.legalBodyId))).toMatchObject(
      refused("pot_not_offered", 409),
    );
    expect(findOwned).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    expectNoChainRead();
    offered = true;
    expect((await declare(body, V3_INPUT)).address).toBe(V3_ADDRESS);
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

  test("refuses pot_exists when the latest declared address holds code, and accepts a new pot when it holds none", async () => {
    const body = linked();
    await declare(body, V3_INPUT);
    clock += 60_000;
    // The first pot was never created: a new one may take its place.
    const second = inputFor(60n);
    const replaced = await declare(body, second);
    expect(replaced).toMatchObject({ address: second.address, onRecord: true });
    expect(chain.port.codeHash.mock.calls).toEqual([[V3_ADDRESS]]);
    // The second was created: no third.
    chain.codes.set((second.address as string).toLowerCase(), SOME_CODE);
    clock += 60_000;
    expect(await refusalOf(() => declare(body, inputFor(70n)))).toMatchObject(
      refused("pot_exists", 409),
    );
    expect(pots.list(body.legalBodyId)).toHaveLength(2);
    expect(potEvents(body)).toHaveLength(2);
  });

  test("a former pot that got its code after it was replaced still holds the body to it: no other pot, but it can be put back", async () => {
    const body = linked();
    await declare(body, V3_INPUT);
    clock += 60_000;
    const second = inputFor(60n);
    await declare(body, second);
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

  test("a former pot that lands after it was replaced: the replacement posted again is pot_exists, not answered", async () => {
    // Y noted, its setup sent from a tab that was lost; X noted in its place while Y had no code.
    const body = linked();
    const y = V3_INPUT;
    const x = inputFor(60n);
    await declare(body, y);
    clock += 60_000;
    await declare(body, x);
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

  test("two pots that both hold code: with the latest taken off, each can be put back, and a new pot cannot", async () => {
    const body = linked();
    const y = V3_INPUT;
    const x = inputFor(60n);
    await declare(body, y);
    clock += 60_000;
    await declare(body, x);
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

  test("the code of the other noted addresses is read at once, not one after the other", async () => {
    const body = linked();
    await declare(body, V3_INPUT);
    clock += 60_000;
    await declare(body, inputFor(60n));
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
    const pending = declare(body, inputFor(70n));
    await vi.waitFor(() => expect(chain.port.codeHash).toHaveBeenCalledTimes(2));
    release();
    expect((await pending).birth.ceilingUnits).toBe("70000000");
  });

  test("two different addresses posted at once: the later write checks again against the note written first", async () => {
    const body = linked();
    const first = inputFor(60n);
    // The other request lands while this one reads the registry.
    registry.getAgentWallet.mockImplementationOnce(async () => {
      await declarePot(deps(), G, body.legalBodyId, first);
      return A;
    });
    const second = await declare(body, V3_INPUT);
    expect(second).toMatchObject({ address: V3_ADDRESS, onRecord: true });
    // The check was made again with the other request's note: its code was read.
    expect(chain.port.codeHash.mock.calls).toEqual([[first.address]]);
    expect(pots.list(body.legalBodyId).map((n) => n.address)).toEqual([first.address, V3_ADDRESS]);
    expect(potEvents(body)).toHaveLength(2);
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
    registry.getAgentWallet.mockRejectedValueOnce(new Error("the node did not answer"));
    clock += 60_000;
    expect(await refusalOf(() => declare(body, inputFor(70n)))).toMatchObject(
      refused("chain_unavailable", 503),
    );
    expect(pots.list(body.legalBodyId)).toHaveLength(1);
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
    await declare(body, second);
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
