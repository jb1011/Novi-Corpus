/**
 * The treasury of record: the guardian of a linked legal body declares which wallet its agent pays
 * from, who provides it and where its limits can be read; Novi stores the declaration, append-only,
 * only once the registry shows that address as the agent's wallet, and states it unsigned.
 *
 * The domain over a real in-memory database and a fake registry, on a fixed clock. Every key is one
 * of anvil's published test accounts, every other address a placeholder, every link, name and
 * company an invention.
 */
import { type Address, type Hex, getAddress, zeroAddress } from "viem";
import { type Mock, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../src/errors";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import {
  type TreasuryDeclaration,
  type TreasuryInput,
  declareTreasury,
  servedTreasury,
  treasuryView,
} from "../../src/legalBody/treasury";
import type { LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import { SqliteLegalBodyTreasuryRepository } from "../../src/persistence/legalBodyTreasuryRepository";
import { ANVIL_ACCOUNT_3 } from "../helpers/customerCompanyFixtures";
import {
  CLOCK_MS,
  CLOCK_S,
  type StatementStores,
  TENANT,
  bodyIn,
  openStatementStores,
  passedCheck,
  readyCompany,
} from "../helpers/legalBodyStatementFixtures";

/** Placeholders: the wallet the agent pays from, and another one. */
const WALLET = getAddress("0x0000000000000000000000000000000000c0ffee");
const ELSEWHERE = getAddress("0x00000000000000000000000000000000000e15e0");
/** An invented page where a provider shows a wallet's limits. */
const LIMITS = "https://limits.example.test/wallets/0001";
/** An invented registry transaction, in upper case, as a wallet might show it. */
const TX_UPPER = `0x${"AB".repeat(32)}` as Hex;

let s: StatementStores;
let treasuries: SqliteLegalBodyTreasuryRepository;
let clock: number;
/** The registry: agent id -> its wallet; absent: none (the zero address). */
let wallets: Map<string, Address>;
let getAgentWallet: Mock<(agentId: bigint) => Promise<Address>>;
let printed: string[];

beforeEach(() => {
  s = openStatementStores();
  treasuries = new SqliteLegalBodyTreasuryRepository(s.db);
  clock = CLOCK_MS;
  wallets = new Map();
  getAgentWallet = vi.fn(async (agentId: bigint) => wallets.get(agentId.toString()) ?? zeroAddress);
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  s.db.close();
});

// biome-ignore lint/suspicious/noExplicitAny: an ops line, read field by field
type OpsLine = Record<string, any>;

/** The ops lines printed for `event`, each without its `opslog` and `at` fields. */
function opsLines(event: string): OpsLine[] {
  return printed.flatMap((line) => {
    try {
      const { opslog, at: _at, ...fields } = JSON.parse(line) as OpsLine;
      return opslog === event ? [fields] : [];
    } catch {
      return [];
    }
  });
}

const deps = () => ({
  repo: treasuries,
  registry: { getAgentWallet },
  bodies: s.repo,
  now: () => clock,
});

/** A row of a ready company of the tenant whose check passed, for agent 42, in `state`, and the
 *  registry showing WALLET as the agent's wallet. */
function bodyInState(state: "linked" | "deployed" | "broken" = "linked"): LegalBodyRecord {
  const companyId = readyCompany(s);
  s.checks.append(passedCheck(companyId));
  const row = bodyIn(state, s, companyId);
  wallets.set("42", WALLET);
  return row;
}

/** A draft of the tenant: no agent, no body. */
function draft(): LegalBodyRecord {
  const companyId = readyCompany(s);
  s.checks.append(passedCheck(companyId));
  return s.repo.create({
    tenantId: TENANT,
    companyId,
    chainId: 31_337,
    factory: getAddress("0x00000000000000000000000000000000000fAc70"),
    amendmentDelay: 172_800,
  });
}

const declare = (row: LegalBodyRecord, input: unknown, tenant: Address = TENANT) =>
  declareTreasury(deps(), tenant, row.legalBodyId, input as TreasuryInput);

/** The refusal `run` ended with. */
async function refusalOf(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("no refusal");
}

const rows = () =>
  s.db.prepare("SELECT * FROM treasury_declarations ORDER BY legal_body_id, declared_at").all();
/** Records the operator's revocation of the body, as `legal-body:revoke` does: an event, with the
 *  row left in its state. */
const revoke = (row: LegalBodyRecord) =>
  s.repo.recordEvent(row.legalBodyId, "revoked", "operator:ops.example", null, {
    reason: "Recorded for a test.",
  });

const notes = (row: LegalBodyRecord) =>
  s.repo
    .listEvents(row.legalBodyId)
    .filter((e) => e.kind === "note" && (e.detail as { act?: string })?.act !== "ordered");

describe("a declaration the registry confirms", () => {
  test("is stored as declared, with one event and one ops line that name the body and the provider, and no link or address", async () => {
    const row = bodyInState();
    const declared = await declare(row, {
      address: WALLET,
      provider: "crossmint",
      limitsReadableAt: LIMITS,
      registryTxHash: TX_UPPER,
    });
    const expected: TreasuryDeclaration = {
      legalBodyId: row.legalBodyId,
      address: WALLET,
      provider: "crossmint",
      providerName: null,
      limitsReadableAt: LIMITS,
      declaredBy: "guardian",
      declaredAt: CLOCK_S,
      // Ruling 5: stored lower-case, never fetched.
      registryTxHash: TX_UPPER.toLowerCase() as Hex,
    };
    expect(declared).toEqual(expected);
    expect(treasuries.latest(row.legalBodyId)).toEqual(expected);
    // One registry read, for the row's agent.
    expect(getAgentWallet.mock.calls).toEqual([[42n]]);

    const events = notes(row);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "note",
      actor: "tenant",
      txHash: null,
      detail: { act: "treasury_declared", provider: "crossmint" },
    });
    expect(Object.keys(events[0]?.detail as object)).toEqual(["act", "provider"]);

    expect(opsLines("legal_body_treasury_declared")).toEqual([
      { legalBodyId: row.legalBodyId, provider: "crossmint" },
    ]);
    // Neither the link nor any address reaches a log line or the event.
    const written = `${printed.join("\n")}\n${JSON.stringify(events)}`;
    expect(written).not.toContain("limits.example");
    expect(written).not.toContain("https");
    expect(written.toLowerCase()).not.toContain(WALLET.toLowerCase());
  });

  test("the registry's wallet matches in any letter case, and the address is stored checksummed", async () => {
    const row = bodyInState();
    const declared = await declare(row, { address: WALLET.toLowerCase(), provider: "circle" });
    expect(declared.address).toBe(WALLET);
    expect(declared.limitsReadableAt).toBeNull();
  });

  test("own_key with no limitsReadableAt is accepted: no provider name, no link", async () => {
    const row = bodyInState();
    const declared = await declare(row, { address: WALLET, provider: "own_key" });
    expect(declared).toMatchObject({
      provider: "own_key",
      providerName: null,
      limitsReadableAt: null,
      registryTxHash: null,
    });
  });

  test("another provider is declared with its name, its spaces normalised; null stands for an absent field", async () => {
    const row = bodyInState();
    const declared = await declare(row, {
      address: WALLET,
      provider: "other",
      providerName: "  Example   Wallets  ",
      limitsReadableAt: null,
      registryTxHash: null,
    });
    expect(declared).toMatchObject({ provider: "other", providerName: "Example Wallets" });
  });

  test("a link of exactly 300 characters is accepted", async () => {
    const row = bodyInState();
    const url = `https://limits.example.test/${"a".repeat(300 - 28)}`;
    expect(url).toHaveLength(300);
    expect(
      (await declare(row, { address: WALLET, provider: "crossmint", limitsReadableAt: url }))
        .limitsReadableAt,
    ).toBe(url);
  });
});

describe("a link to the limits is stored as written, and only when that is where it leads", () => {
  test.each([
    ["a host in capitals", "https://LIMITS.example.test/wallets/0001"],
    ["a port other than the default", "https://limits.example.test:8443/wallets/0001"],
    ["a query right after the host", "https://limits.example.test?wallet=0001"],
    ["a fragment right after the host", "https://limits.example.test#wallet-0001"],
    ["a bare host", "https://limits.example.test"],
  ])("%s: accepted", async (_, url) => {
    const row = bodyInState();
    const declared = await declare(row, {
      address: WALLET,
      provider: "crossmint",
      limitsReadableAt: url,
    });
    expect(declared.limitsReadableAt).toBe(url);
  });
});

describe("refused, with nothing stored and no event", () => {
  test("an address the registry does not show as the agent's wallet: 409 treasury_wallet_mismatch", async () => {
    const row = bodyInState();
    const refused = await refusalOf(() =>
      declare(row, { address: ELSEWHERE, provider: "crossmint" }),
    );
    expect(refused).toMatchObject({ code: "treasury_wallet_mismatch", status: 409 });
    expect(refused.message).toBe(LEGAL_BODY_SENTENCES.treasury_wallet_mismatch);
    expect(refused.message).toBe(
      "The registry does not show this address as the agent's wallet: finish the attach first.",
    );
    // An agent with no wallet at all: the zero address is no one's wallet.
    wallets.delete("42");
    expect(
      await refusalOf(() => declare(row, { address: WALLET, provider: "crossmint" })),
    ).toMatchObject({ code: "treasury_wallet_mismatch", status: 409 });
    expect(rows()).toEqual([]);
    expect(notes(row)).toEqual([]);
    expect(opsLines("legal_body_treasury_declared")).toEqual([]);
  });

  const ok = { address: WALLET, provider: "crossmint" };
  const invalid: [string, unknown][] = [
    ["an http: link", { ...ok, limitsReadableAt: "http://limits.example.test/wallets/0001" }],
    [
      "a link of 301 characters",
      { ...ok, limitsReadableAt: `https://limits.example.test/${"a".repeat(301 - 28)}` },
    ],
    ["a link in another scheme", { ...ok, limitsReadableAt: "ftp://limits.example.test/" }],
    ["a scheme in capitals", { ...ok, limitsReadableAt: "HTTPS://limits.example.test/" }],
    ["text that is not a link", { ...ok, limitsReadableAt: "see the provider's page" }],
    [
      "a link with credentials",
      { ...ok, limitsReadableAt: "https://ops:secret@limits.example.test/" },
    ],
    ["a link holding a space", { ...ok, limitsReadableAt: "https://limits.example.test/a b" }],
    [
      "a link holding a double quote",
      { ...ok, limitsReadableAt: 'https://limits.example.test/"x"' },
    ],
    [
      "a link holding an angle bracket",
      { ...ok, limitsReadableAt: "https://limits.example.test/<x>" },
    ],
    ["an empty link", { ...ok, limitsReadableAt: "" }],
    // The authority as written must be the host the link leads to.
    ["a link with an empty authority", { ...ok, limitsReadableAt: "https:///path" }],
    [
      "a link with empty credentials",
      { ...ok, limitsReadableAt: "https://:@limits.example.test/x" },
    ],
    [
      "a link with a user before its host",
      { ...ok, limitsReadableAt: "https://limits.example.test@elsewhere.example.test/x" },
    ],
    [
      "a link whose host is written percent-encoded",
      { ...ok, limitsReadableAt: "https://limits%2Eexample.test/x" },
    ],
    [
      "a link that writes the default port",
      { ...ok, limitsReadableAt: "https://limits.example.test:443/x" },
    ],
    ["a link that is not text", { ...ok, limitsReadableAt: 42 }],
    ["another provider with no name", { address: WALLET, provider: "other" }],
    [
      "another provider with an empty name",
      { address: WALLET, provider: "other", providerName: " " },
    ],
    [
      "another provider with a name of 81 characters",
      { address: WALLET, provider: "other", providerName: "W".repeat(81) },
    ],
    [
      "another provider with a control character in its name",
      { address: WALLET, provider: "other", providerName: "Example\u0000Wallets" },
    ],
    [
      "another provider whose name is a link",
      { address: WALLET, provider: "other", providerName: "https://wallets.example.test" },
    ],
    ["a name for crossmint", { ...ok, providerName: "Crossmint" }],
    ["a name for circle", { address: WALLET, provider: "circle", providerName: "Circle" }],
    ["a name for own_key", { address: WALLET, provider: "own_key", providerName: "Mine" }],
    ["a provider this record does not know", { address: WALLET, provider: "privy" }],
    ["no provider", { address: WALLET }],
    ["no address", { provider: "crossmint" }],
    ["an address that is too short", { ...ok, address: "0x1234" }],
    ["the zero address", { ...ok, address: zeroAddress }],
    // WALLET checksums to 0x…C0FFEE: one letter in the other case breaks the checksum.
    ["a mixed-case address with a wrong checksum", { ...ok, address: `${WALLET.slice(0, -1)}e` }],
    ["a registry transaction hash of 2 bytes", { ...ok, registryTxHash: "0x1234" }],
    ["a registry transaction hash of 31 bytes", { ...ok, registryTxHash: `0x${"ab".repeat(31)}` }],
    ["a registry transaction hash of 33 bytes", { ...ok, registryTxHash: `0x${"ab".repeat(33)}` }],
    [
      "a registry transaction hash that is not hex",
      { ...ok, registryTxHash: `0x${"g".repeat(64)}` },
    ],
    ["a registry transaction hash with no 0x", { ...ok, registryTxHash: "ab".repeat(32) }],
    ["a registry transaction hash that is a number", { ...ok, registryTxHash: 1 }],
    ["a field this record does not take", { ...ok, limitsReadableUrl: LIMITS }],
    ["no object", null],
    ["a list", [ok]],
    ["a string", "crossmint"],
  ];
  test.each(invalid)("%s: 400 treasury_invalid, and the registry is not read", async (_, input) => {
    const row = bodyInState();
    const refused = await refusalOf(() => declare(row, input));
    expect(refused).toMatchObject({ code: "treasury_invalid", status: 400 });
    expect(refused.message).toBe(LEGAL_BODY_SENTENCES.treasury_invalid);
    expect(getAgentWallet).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    expect(notes(row)).toEqual([]);
  });

  test("a linked body the operator revoked: 409 order_revoked, the registry not read, nothing written", async () => {
    const row = bodyInState();
    revoke(row);
    // A revocation leaves the row linked: only its event says so.
    expect(s.repo.findById(row.legalBodyId)?.bindingState).toBe("linked");
    const refused = await refusalOf(() => declare(row, ok));
    expect(refused).toMatchObject({ code: "order_revoked", status: 409 });
    expect(refused.message).toBe(LEGAL_BODY_SENTENCES.order_revoked);
    expect(getAgentWallet).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    expect(notes(row)).toEqual([]);
    expect(opsLines("legal_body_treasury_declared")).toEqual([]);
  });

  test("a body revoked while the registry is read: 409 order_revoked, nothing written", async () => {
    const row = bodyInState();
    getAgentWallet.mockImplementationOnce(async () => {
      revoke(row);
      return WALLET;
    });
    expect(await refusalOf(() => declare(row, ok))).toMatchObject({
      code: "order_revoked",
      status: 409,
    });
    expect(rows()).toEqual([]);
    expect(notes(row)).toEqual([]);
  });

  test.each(["deployed", "broken"] as const)(
    "a body that is %s, not linked: 409 order_closed, and the registry is not read",
    async (state) => {
      const row = bodyInState(state);
      const refused = await refusalOf(() => declare(row, ok));
      expect(refused).toMatchObject({ code: "order_closed", status: 409 });
      expect(refused.message).toBe(LEGAL_BODY_SENTENCES.order_closed);
      expect(getAgentWallet).not.toHaveBeenCalled();
      expect(rows()).toEqual([]);
    },
  );

  test("a draft, with no body yet: 409 order_closed", async () => {
    const row = draft();
    expect(await refusalOf(() => declare(row, ok))).toMatchObject({
      code: "order_closed",
      status: 409,
    });
    expect(getAgentWallet).not.toHaveBeenCalled();
  });

  test("another tenant's body, or an id no body holds: the one 404 not_found", async () => {
    const row = bodyInState();
    for (const run of [
      () => declare(row, ok, ANVIL_ACCOUNT_3.address),
      () => declareTreasury(deps(), TENANT, `lb_${"0".repeat(36)}`, ok as TreasuryInput),
    ])
      expect(await refusalOf(run)).toMatchObject({ code: "not_found", status: 404 });
    expect(getAgentWallet).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  test("a body that stops being linked while the registry is read: 409 order_closed", async () => {
    const row = bodyInState();
    getAgentWallet.mockImplementationOnce(async () => {
      expect(s.repo.markBroken(row.legalBodyId, { reason: "not_linked" })).toBe(true);
      return WALLET;
    });
    expect(await refusalOf(() => declare(row, ok))).toMatchObject({
      code: "order_closed",
      status: 409,
    });
    expect(rows()).toEqual([]);
    expect(notes(row)).toEqual([]);
  });

  test("a registry that cannot be read: 503 chain_unavailable, and one ops line naming the error's name only", async () => {
    const row = bodyInState();
    getAgentWallet.mockRejectedValueOnce(
      Object.assign(new Error("HTTP request failed. URL: https://rpc.example/v2/key-in-path"), {
        name: "HttpRequestError",
        status: 429,
      }),
    );
    const refused = await refusalOf(() => declare(row, ok));
    expect(refused).toMatchObject({ code: "chain_unavailable", status: 503 });
    expect(opsLines("legal_body_chain_unavailable")).toEqual([
      {
        level: "warn",
        orderId: row.legalBodyId,
        stage: "treasury_wallet",
        errorName: "HttpRequestError",
      },
    ]);
    expect(printed.join("\n")).not.toContain("rpc.example");
    expect(rows()).toEqual([]);
  });
});

describe("the record is append-only, and its latest row is the record", () => {
  test("a second declaration appends, and the view shows the latest", async () => {
    const row = bodyInState();
    await declare(row, { address: WALLET, provider: "crossmint", limitsReadableAt: LIMITS });
    clock += 60_000;
    // The attach moved: the registry now shows another wallet, declared with another provider.
    wallets.set("42", ELSEWHERE);
    await declare(row, { address: ELSEWHERE, provider: "circle" });
    expect(rows()).toHaveLength(2);
    const latest = treasuries.latest(row.legalBodyId);
    expect(latest).toMatchObject({
      address: ELSEWHERE,
      provider: "circle",
      limitsReadableAt: null,
      declaredAt: CLOCK_S + 60,
    });
    expect(treasuryView(latest)).toMatchObject({ address: ELSEWHERE, provider: "circle" });
    expect(notes(row).map((e) => e.detail)).toEqual([
      { act: "treasury_declared", provider: "crossmint" },
      { act: "treasury_declared", provider: "circle" },
    ]);
  });

  test("two declarations in one second, or after a clock that went back, are both kept, in the order they were made", async () => {
    const row = bodyInState();
    const first = await declare(row, { address: WALLET, provider: "crossmint" });
    const second = await declare(row, { address: WALLET, provider: "own_key" });
    clock -= 3_600_000;
    const third = await declare(row, { address: WALLET, provider: "circle" });
    expect([first.declaredAt, second.declaredAt, third.declaredAt]).toEqual([
      CLOCK_S,
      CLOCK_S + 1,
      CLOCK_S + 2,
    ]);
    expect(treasuries.latest(row.legalBodyId)?.provider).toBe("circle");
  });

  test("the table refuses an update, a delete, a replace, and a row that is not after the body's latest", async () => {
    const row = bodyInState();
    await declare(row, { address: WALLET, provider: "crossmint" });
    expect(() =>
      s.db.prepare("UPDATE treasury_declarations SET provider = 'circle'").run(),
    ).toThrow(/append-only/);
    expect(() => s.db.prepare("DELETE FROM treasury_declarations").run()).toThrow(/append-only/);
    const insert = (verb: string, at: number) =>
      s.db
        .prepare(
          `${verb} INTO treasury_declarations (legal_body_id, address, provider, declared_at)
           VALUES (?, ?, 'circle', ?)`,
        )
        .run(row.legalBodyId, WALLET, at);
    for (const verb of ["INSERT", "INSERT OR REPLACE", "REPLACE"])
      for (const at of [CLOCK_S, CLOCK_S - 1])
        expect(() => insert(verb, at), `${verb} at ${at}`).toThrow(/in order|append-only/);
    expect(rows()).toHaveLength(1);
    expect(treasuries.latest(row.legalBodyId)?.provider).toBe("crossmint");
  });

  test("the table's CHECKs hold the shapes the domain writes, and its foreign key the body", () => {
    const row = bodyInState();
    const insert = (cols: Record<string, unknown>) => {
      const all = {
        legal_body_id: row.legalBodyId,
        address: WALLET,
        provider: "crossmint",
        provider_name: null,
        limits_readable_at: null,
        declared_at: CLOCK_S,
        registry_tx_hash: null,
        ...cols,
      };
      return s.db
        .prepare(
          `INSERT INTO treasury_declarations
             (legal_body_id, address, provider, provider_name, limits_readable_at, declared_at,
              registry_tx_hash)
           VALUES (@legal_body_id, @address, @provider, @provider_name, @limits_readable_at,
                   @declared_at, @registry_tx_hash)`,
        )
        .run(all);
    };
    for (const [label, cols] of [
      ["the zero address", { address: zeroAddress }],
      ["an address that is not one", { address: "0x1234" }],
      ["an unknown provider", { provider: "privy" }],
      ["another provider with no name", { provider: "other" }],
      ["a name for a known provider", { provider_name: "Crossmint" }],
      ["an http link", { limits_readable_at: "http://limits.example.test/" }],
      ["a link of 301 characters", { limits_readable_at: `https://${"a".repeat(293)}` }],
      ["a hash in upper case", { registry_tx_hash: TX_UPPER }],
      ["a time in milliseconds", { declared_at: CLOCK_MS }],
      ["another declarer", { declared_by: "operator" }],
    ] as const) {
      const run = () =>
        "declared_by" in cols
          ? s.db
              .prepare(
                "INSERT INTO treasury_declarations (legal_body_id, address, provider, declared_by, declared_at) VALUES (?, ?, 'crossmint', 'operator', ?)",
              )
              .run(row.legalBodyId, WALLET, CLOCK_S)
          : insert(cols);
      expect(run, label).toThrow(/CHECK constraint failed/);
    }
    expect(() => insert({ legal_body_id: `lb_${"9".repeat(36)}` })).toThrow(/FOREIGN KEY/);
    expect(rows()).toEqual([]);
    expect(s.db.prepare("PRAGMA foreign_key_list(treasury_declarations)").all()).toMatchObject([
      { table: "legal_bodies", from: "legal_body_id", to: "legal_body_id" },
    ]);
  });
});

describe("what is served", () => {
  test("the view: the declaration's public fields, declared by the guardian, never checked by Novi", async () => {
    const row = bodyInState();
    const declared = await declare(row, {
      address: WALLET,
      provider: "crossmint",
      limitsReadableAt: LIMITS,
      registryTxHash: TX_UPPER,
    });
    const view = treasuryView(declared);
    expect(view).toEqual({
      address: WALLET,
      provider: "crossmint",
      providerName: null,
      limitsReadableAt: LIMITS,
      declaredBy: "guardian",
      declaredAt: CLOCK_S,
      checkedByNovi: false,
    });
    // The transaction hash is the record's, not the public block's.
    expect(Object.keys(view ?? {})).toEqual([
      "address",
      "provider",
      "providerName",
      "limitsReadableAt",
      "declaredBy",
      "declaredAt",
      "checkedByNovi",
    ]);
    expect(treasuryView(undefined)).toBeNull();
  });

  test("Ruling 3: served only while its address is the agent's wallet the same answer read, in any letter case", async () => {
    const row = bodyInState();
    const declared = await declare(row, { address: WALLET, provider: "own_key" });
    const stated = (agentWallet: Address) => ({ agentWallet, standing: "active" as const });
    expect(servedTreasury(declared, stated(WALLET))).toEqual(treasuryView(declared));
    expect(servedTreasury(declared, stated(WALLET.toLowerCase() as Address))).toEqual(
      treasuryView(declared),
    );
    expect(servedTreasury(declared, stated(ELSEWHERE))).toBeNull();
    expect(servedTreasury(declared, stated(zeroAddress))).toBeNull();
    expect(servedTreasury(undefined, stated(WALLET))).toBeNull();
  });

  test("served only beside a statement in force: active or pending; inactive or unknown, null with the wallet matching", async () => {
    const row = bodyInState();
    const declared = await declare(row, { address: WALLET, provider: "crossmint" });
    for (const standing of ["active", "pending"] as const)
      expect(servedTreasury(declared, { agentWallet: WALLET, standing }), standing).toEqual(
        treasuryView(declared),
      );
    for (const standing of ["inactive", "unknown"] as const)
      expect(servedTreasury(declared, { agentWallet: WALLET, standing }), standing).toBeNull();
    // Ruling 3 still applies on top: in force, but another wallet.
    expect(servedTreasury(declared, { agentWallet: ELSEWHERE, standing: "active" })).toBeNull();
  });

  test("Ruling 8: neither sentence says non-custodial, insured, guaranteed or verified wallet", () => {
    for (const code of ["treasury_invalid", "treasury_wallet_mismatch"]) {
      const sentence = LEGAL_BODY_SENTENCES[code];
      expect(sentence, code).toBeDefined();
      expect(sentence, code).not.toMatch(/non-custodial|insured|guaranteed|verified wallet/i);
    }
  });
});
