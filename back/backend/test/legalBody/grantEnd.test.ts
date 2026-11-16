/**
 * The grant of an order on the Charter, read back and checked at every door that acts on the
 * draft, and its end checked again where a legal body could be created under it. The rule is one
 * for every moment: a legal body is created before the last day of its grant begins. At the
 * adoption the moment is now; at the link doors it is the link's deadline, the latest moment the
 * legal body can be created.
 *
 * No date is written out here: every day is counted from the real clock, so the tests hold
 * whatever day they run, and the fake chain's clock is steered to match. The database is real (in
 * memory). Every amount is a made-up fixture; every name, company and filing number is an
 * invention, and every key is one of anvil's published test accounts.
 */
import { type Address, getAddress } from "viem";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../src/errors";
import { adoptAgreement, adoptionMessage } from "../../src/legalBody/adoption";
import { readVerifiedAgreement } from "../../src/legalBody/agreement";
import { type GrantChoices, buildGrant, utcDay } from "../../src/legalBody/grant";
import {
  type LinkSubmitResult,
  assertOpenDraft,
  linkMessage,
  submitLink,
} from "../../src/legalBody/linkDoor";
import { assertGrantOutlasts, readOrderGrant } from "../../src/legalBody/orderGrant";
import { type LegalBodyOrderDeps, createOrder } from "../../src/legalBody/orders";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { CHARTER_LEGAL_TEXTS } from "../../src/legalBody/texts/sets";
import type {
  CharterGrantRepository,
  CharterGrantRow,
} from "../../src/persistence/charterGrantRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import type { LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import { ANVIL_ACCOUNT_2, recordHuman } from "../helpers/customerCompanyFixtures";
import { A, B } from "../helpers/grantFixtures";
import {
  DAY_MS,
  type FakeLinkChainMembers,
  type LegalBodyStores,
  adoptFor,
  asChainPort,
  customerCompany,
  fakeLinkChainMembers,
  legalBodyOrderDeps,
  linkFor,
  noChain,
  openLegalBodyStores,
  orderViewOf,
  signedLink,
} from "../helpers/legalBodyFixtures";

/** The guardian of every order here, a verified human. */
const tenant: Address = getAddress(ANVIL_ACCOUNT_2.address);

// The clock stands at 12:00:00 UTC of the real day while this file runs, so a run that crosses
// 00:00 UTC still reads one day. Only `Date` is mocked, not the timers: what is placed or adopted
// "by the real clock" reads that noon, and every other moment is an explicit `now` or the fake
// chain's time.
vi.setSystemTime(Date.parse(`${utcDay(Date.now())}T12:00:00Z`));
afterAll(() => {
  vi.useRealTimers();
});

const today = utcDay(Date.now());
const tomorrowStartsMs = Date.parse(`${today}T00:00:00Z`) + DAY_MS;
const tomorrow = utcDay(tomorrowStartsMs);
const dayAfter = utcDay(tomorrowStartsMs + DAY_MS);
/** The chain's time in these tests: tomorrow, 08:00:00 UTC, in unix seconds. */
const chainNow = BigInt(tomorrowStartsMs / 1000 + 8 * 3600);
/** The first second of the day after tomorrow: 57,600 seconds after `chainNow`. */
const dayAfterStarts = chainNow + 57_600n;

let s: LegalBodyStores;
let chain: FakeLinkChainMembers;
let lines: string[];
let filings = 0;

beforeEach(() => {
  const db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  recordHuman(s.store, tenant, "3001", Date.now());
  chain = fakeLinkChainMembers();
  chain.head.mockResolvedValue({ number: 7_777n, timestamp: chainNow });
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  s.db.close();
});

/** The doors' deps of a sandbox deployment that serves the Charter pair, over the fake chain,
 *  with room in every throttle. */
function deps(over: Partial<LegalBodyOrderDeps> = {}): LegalBodyOrderDeps {
  return legalBodyOrderDeps(s, {
    chain: asChainPort(chain),
    texts: CHARTER_LEGAL_TEXTS,
    maxOpenPerTenant: 50,
    maxOrdersPerTenantPerDay: 50,
    ...over,
  });
}

/** The deps of a door at `nowMs`. */
const at = (nowMs: number, over: Partial<LegalBodyOrderDeps> = {}) =>
  deps({ now: () => nowMs, ...over });

function rowOf(id: string): LegalBodyRecord {
  const row = s.repo.findById(id);
  if (!row) throw new Error(`order ${id} is not stored`);
  return row;
}

/** A checked company of the guardian, with a filing number no other company of the test holds. */
const company = (opts: Parameters<typeof customerCompany>[2] = {}) =>
  customerCompany(s, tenant, {
    filingNumber: `TEST-${String(++filings).padStart(4, "0")}`,
    ...opts,
  });

/** An order on the Charter with fixture `A` and that end, placed by the real clock. */
function order(endsOn: string | null): LegalBodyRecord {
  const grant: GrantChoices = { ...structuredClone(A), endsOn };
  const companyId = company({ wordingVersion: "2026-11-draft-2" });
  return rowOf(createOrder(deps(), tenant, { companyId, grant }).id);
}

/** An order on the October pair, which takes no grant. */
function octoberOrder(): LegalBodyRecord {
  return rowOf(
    createOrder(legalBodyOrderDeps(s, { maxOpenPerTenant: 50 }), tenant, { companyId: company() })
      .id,
  );
}

/** As `order`, its agreement adopted by its guardian by the real clock, as every link requires. */
function adopted(endsOn: string | null): LegalBodyRecord {
  const row = order(endsOn);
  adoptFor(s, row);
  return rowOf(row.legalBodyId);
}

async function refusedAsync(run: () => unknown, code: string, status: number): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected the refusal ${code}`).toBeInstanceOf(ApiError);
  const err = caught as ApiError;
  expect({ code: err.code, status: err.status, message: err.message }).toEqual({
    code,
    status,
    message: LEGAL_BODY_SENTENCES[code],
  });
}

/** What happens once the row is reserved: here, nothing but the answer `reserved`. */
const afterReserve = {
  create: async (row: LegalBodyRecord): Promise<LinkSubmitResult> => ({
    status: "reserved",
    order: orderViewOf(deps(), row),
  }),
};

/** The order's stored agreement, re-verified. */
function verifiedOf(row: LegalBodyRecord) {
  if (row.oaManifestHash === null) throw new Error(`order ${row.legalBodyId} has no agreement`);
  const verified = readVerifiedAgreement(s.docStore, row.legalBodyId, row.oaManifestHash);
  if (verified === undefined) throw new Error(`order ${row.legalBodyId}: unreadable agreement`);
  return verified;
}

/** The ops lines written with this event, parsed. */
const opsLines = (event: string) =>
  lines.map((line) => JSON.parse(line)).filter((entry) => entry.opslog === event);

// ── The adoption ────────────────────────────────────────────────────────────────────────────

describe("the adoption doors", () => {
  test("the adoption message is served until the grant's last day begins, and refused from its first second", async () => {
    const row = order(tomorrow);

    const served = adoptionMessage(at(tomorrowStartsMs - 1000), tenant, row.legalBodyId);
    expect(served.typedData.primaryType).toBe("OperatingAgreementAdoption");
    expect(served.typedData.message.orderId).toBe(row.legalBodyId);
    expect(served.issuedAt).toBe(String(tomorrowStartsMs / 1000 - 1));

    await refusedAsync(
      () => adoptionMessage(at(tomorrowStartsMs), tenant, row.legalBodyId),
      "grant_ends_too_soon",
      409,
    );
  });

  test("the adoption is refused the same way, before the signature is read", async () => {
    const row = order(tomorrow);
    await refusedAsync(
      () =>
        adoptAgreement(at(tomorrowStartsMs), tenant, row.legalBodyId, {
          issuedAt: "x",
          signature: "0x",
        }),
      "grant_ends_too_soon",
      409,
    );
    expect(s.adoptions.find(row.legalBodyId)).toBeUndefined();
  });

  test("an order adopted before the day began answers its stored adoption after it", async () => {
    const row = order(tomorrow);
    adoptFor(s, row);
    const stored = s.adoptions.find(row.legalBodyId);
    if (stored === undefined) throw new Error("no adoption stored");

    await expect(
      adoptAgreement(at(tomorrowStartsMs), tenant, row.legalBodyId, {
        issuedAt: "x",
        signature: "0x",
      }),
    ).resolves.toEqual({ adoptedAt: stored.adoptedAt });
  });

  test("a grant with no end, and an order on the October pair, are never refused for their end", () => {
    const open = order(null);
    expect(
      adoptionMessage(at(tomorrowStartsMs), tenant, open.legalBodyId).typedData.message.orderId,
    ).toBe(open.legalBodyId);

    const october = octoberOrder();
    const served = adoptionMessage(
      legalBodyOrderDeps(s, { now: () => tomorrowStartsMs }),
      tenant,
      october.legalBodyId,
    );
    expect(served.typedData.message.orderId).toBe(october.legalBodyId);
  });
});

// ── The link doors ──────────────────────────────────────────────────────────────────────────

describe("the link doors", () => {
  test("the link message is refused when the link's deadline reaches the grant's last day", async () => {
    // Its last day began at 00:00 UTC tomorrow, before the chain's time.
    const ended = adopted(tomorrow);
    await refusedAsync(
      () => linkMessage(deps(), tenant, ended.legalBodyId, { agentId: "42" }),
      "link_outlasts_grant",
      409,
    );

    const row = adopted(dayAfter);
    const byDefault = await linkMessage(deps(), tenant, row.legalBodyId, { agentId: "42" });
    expect(byDefault.deadline).toBe(Number(chainNow + 3_600n));

    const lastSecond = await linkMessage(deps(), tenant, row.legalBodyId, {
      agentId: "42",
      ttlSeconds: 57_599,
    });
    expect(lastSecond.deadline).toBe(Number(dayAfterStarts) - 1);

    for (const ttlSeconds of [57_600, 85_800])
      await refusedAsync(
        () => linkMessage(deps(), tenant, row.legalBodyId, { agentId: "42", ttlSeconds }),
        "link_outlasts_grant",
        409,
      );

    // The remedy the sentence names: after the refusal, the same order serves an earlier
    // deadline, and it is still a draft.
    const earlier = await linkMessage(deps(), tenant, row.legalBodyId, {
      agentId: "42",
      ttlSeconds: 57_599,
    });
    expect(earlier.deadline).toBe(Number(dayAfterStarts) - 1);
    expect(rowOf(row.legalBodyId).bindingState).toBe("draft");
  });

  test("a signed link whose deadline reaches the grant's last day is refused before the chain is read, and the draft is kept", async () => {
    const row = adopted(dayAfter);
    const identityBucket = vi.fn(() => ({ take: () => true }));

    const late = await signedLink(linkFor(row, { deadline: dayAfterStarts }));
    await refusedAsync(
      () =>
        submitLink(
          deps({ chain: noChain, identityBucket }),
          tenant,
          row.legalBodyId,
          late,
          afterReserve,
        ),
      "link_outlasts_grant",
      409,
    );
    expect(identityBucket).not.toHaveBeenCalled();
    expect(rowOf(row.legalBodyId).bindingState).toBe("draft");

    const inTime = await signedLink(linkFor(row, { deadline: dayAfterStarts - 1n }));
    const answer = await submitLink(deps(), tenant, row.legalBodyId, inTime, afterReserve);
    expect(answer.status).not.toBe("refused");
    expect(rowOf(row.legalBodyId).bindingState).toBe("reserved");
  });
});

// ── The stored grant, read back ─────────────────────────────────────────────────────────────

/** The grant rows a stub answers in place of the order's own, from the real row. */
const STORED: Record<string, (row: CharterGrantRow) => CharterGrantRow[]> = {
  no_row: () => [],
  wording_unknown: (row) => [{ ...row, wording: "2026-11-draft-9" }],
  not_canonical: (row) => [{ ...row, canonical: `${row.canonical} ` }],
  digest_mismatch: (row) => [{ ...row, digest: buildGrant(B, { number: 1, version: 1 }).digest }],
  not_in_terms: (row) => {
    const other = buildGrant(B, { number: 1, version: 1 });
    return [{ ...row, canonical: other.canonical, digest: other.digest }];
  },
};

describe("the stored grant", () => {
  test.each(Object.keys(STORED))(
    "a stored grant that does not check is never adopted or linked: %s",
    async (reason) => {
      const row = order(null);
      const real = s.grants.list(row.legalBodyId);
      expect(real).toHaveLength(1);
      const answered = STORED[reason]?.(real[0] as CharterGrantRow) ?? [];
      const grants: CharterGrantRepository = {
        insert: () => {
          throw new Error("the stub takes no grant");
        },
        list: () => answered,
      };
      lines = [];

      await refusedAsync(
        () => adoptionMessage(deps({ grants }), tenant, row.legalBodyId),
        "grant_unreadable",
        500,
      );
      const written = opsLines("legal_body_grant_unverifiable");
      expect(written).toHaveLength(1);
      expect(written[0]).toEqual({
        opslog: "legal_body_grant_unverifiable",
        at: expect.any(String),
        level: "error",
        legalBodyId: row.legalBodyId,
        reason,
      });

      adoptFor(s, row);
      await refusedAsync(
        () => linkMessage(deps({ grants }), tenant, row.legalBodyId, { agentId: "42" }),
        "grant_unreadable",
        500,
      );
    },
  );

  test("the grant read back is the grant ordered", () => {
    const row = order(null);
    const ordered = buildGrant(A, { number: 1, version: 1 });
    expect(assertOpenDraft(deps(), row, Date.now()).grant).toEqual(ordered);
    expect(readOrderGrant(deps(), row.legalBodyId, verifiedOf(row))).toEqual(ordered);

    const october = octoberOrder();
    expect(assertOpenDraft(legalBodyOrderDeps(s), october, Date.now()).grant).toBeNull();
    expect(readOrderGrant(deps(), october.legalBodyId, verifiedOf(october))).toBeNull();
  });

  test("the end is compared in whole seconds as a bigint, so a deadline of any size a link carries is compared", async () => {
    const ending = buildGrant(
      { ...structuredClone(A), endsOn: dayAfter },
      { number: 1, version: 1 },
    );
    const open = buildGrant(A, { number: 1, version: 1 });
    expect(() => assertGrantOutlasts(ending, dayAfterStarts - 1n)).not.toThrow();
    for (const atSec of [dayAfterStarts, 2n ** 256n - 1n])
      await refusedAsync(() => assertGrantOutlasts(ending, atSec), "grant_ends_too_soon", 409);
    for (const grant of [open, null])
      expect(() => assertGrantOutlasts(grant, 2n ** 256n - 1n)).not.toThrow();
  });
});
