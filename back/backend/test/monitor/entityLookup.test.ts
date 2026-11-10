import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, getAddress } from "viem";
import { describe, expect, test } from "vitest";
import {
  SqliteEntityLookup,
  assertLookupSchema,
  indexEntities,
  indexLegalBodies,
} from "../../src/monitor/entityLookup";
import { EntityLookupError } from "../../src/monitor/errors";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteLegalBodyRepository } from "../../src/persistence/legalBodyRepository";
import type { EntityRecord } from "../../src/types";
import { ADDR, entity } from "./helpers";

function record(over: Partial<EntityRecord> = {}): EntityRecord {
  return {
    idempotencyKey: "key-1",
    name: "Acme Agent LLC",
    status: "funded",
    manager: ADDR.controller,
    guardian: ADDR.guardian,
    operator: ADDR.operator,
    amendmentDelay: "86400",
    ein: "00-0000000",
    formationDate: 1_700_000_000,
    oaHash: null,
    metadataURI: null,
    docPath: null,
    treasuryConfig: null,
    agentId: "881938",
    proxy: "0x8888888888888888888888888888888888888888",
    treasury: ADDR.treasury,
    createTxHash: null,
    bindTxHash: null,
    fundTxHash: null,
    error: null,
    publicId: "pub-1",
    ...over,
  } as EntityRecord;
}

/** Build a real legalbody.db with the production migration, then read it as the monitor does. */
function seedMainDb(records: EntityRecord[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "novi-main-db-")), "legalbody.db");
  const db = openDatabase(path);
  migrate(db);
  const repo = new SqliteEntityRepository(db);
  for (const r of records) repo.upsert(r);
  db.close();
  return path;
}

describe("SqliteEntityLookup", () => {
  test("reads entities with an on-chain footprint", () => {
    const lookup = new SqliteEntityLookup(seedMainDb([record()]));
    const [e] = lookup.all();
    expect(e?.agentId).toBe("881938");
    expect(e?.treasury).toBe(ADDR.treasury);
    expect(e?.operator).toBe(ADDR.operator);
    expect(e?.guardian).toBe(ADDR.guardian);
    expect(e?.manager).toBe(ADDR.controller);
    expect(e?.publicId).toBe("pub-1");
    lookup.close();
  });

  test("skips rows with neither a treasury nor an agentId (nothing on-chain to watch)", () => {
    const lookup = new SqliteEntityLookup(
      seedMainDb([
        record(),
        record({ idempotencyKey: "key-2", agentId: null, treasury: null, publicId: "pub-2" }),
      ]),
    );
    expect(lookup.all()).toHaveLength(1);
    lookup.close();
  });

  test("the handle is READ-ONLY — a write against it is refused by better-sqlite3", () => {
    const path = seedMainDb([record()]);
    const lookup = new SqliteEntityLookup(path);
    lookup.all(); // force the connection open
    // Reach into the private handle deliberately: this asserts the guarantee the class claims.
    const db = (lookup as unknown as { db: { prepare: (s: string) => { run: () => void } } }).db;
    expect(() => db.prepare("DELETE FROM entities").run()).toThrow(/readonly|read.only/i);
    lookup.close();
  });

  test("a missing database is a NAMED recoverable error, not a crash", () => {
    const lookup = new SqliteEntityLookup("/nonexistent/dir/legalbody.db");
    expect(() => lookup.all()).toThrow(EntityLookupError);
    expect(() => lookup.all()).toThrow(/DATA_DIR/);
  });

  test("an un-migrated database surfaces as EntityLookupError, and the handle is dropped", () => {
    const path = join(mkdtempSync(join(tmpdir(), "novi-empty-db-")), "legalbody.db");
    openDatabase(path).close(); // exists, but has no `entities` table
    const lookup = new SqliteEntityLookup(path);
    expect(() => lookup.all()).toThrow(EntityLookupError);
    lookup.close();
  });

  test("F4: a PR-2-shaped database FAILS THE STARTUP PROBE, naming the deploy order", () => {
    // The monitor deployed ahead of the API on a release that adds a column. Mid-run this is
    // tolerated (the last entity set is reused); at STARTUP it must stop the process, because the
    // alternative is a watcher that scans, logs `monitor_scanned` and is silently blind to every
    // treasury and every LegalManager proxy it exists to watch.
    const path = seedMainDb([record()]);
    const writer = openDatabase(path);
    writer.exec("ALTER TABLE entities DROP COLUMN oa_manifest_pending_version");
    writer.close();

    const lookup = new SqliteEntityLookup(path);
    expect(() => assertLookupSchema(lookup)).toThrow(EntityLookupError);
    expect(() => assertLookupSchema(lookup)).toThrow(/restart the API/i);
    expect(() => assertLookupSchema(lookup)).toThrow(/DEPLOY ORDER/);
    try {
      assertLookupSchema(lookup);
    } catch (err) {
      expect((err as EntityLookupError).schemaMismatch).toBe(true);
    }
    lookup.close();
  });

  test("F4: a healthy database passes the startup probe", () => {
    const lookup = new SqliteEntityLookup(seedMainDb([record()]));
    expect(() => assertLookupSchema(lookup)).not.toThrow();
    lookup.close();
  });

  test("reads while the API holds the DB open (WAL: readers never block on a writer)", () => {
    const path = seedMainDb([record()]);
    const writer = openDatabase(path); // simulates the running API
    const repo = new SqliteEntityRepository(writer);
    repo.upsert(record({ idempotencyKey: "key-2", agentId: "999", publicId: "pub-2" }));

    const lookup = new SqliteEntityLookup(path);
    expect(lookup.all()).toHaveLength(2);
    lookup.close();
    writer.close();
  });
});

describe("indexEntities", () => {
  test("indexes by lowercased treasury and by agentId", () => {
    const index = indexEntities([entity()]);
    expect(index.byTreasury.get(ADDR.treasury.toLowerCase())?.name).toBe("Acme Agent LLC");
    expect(index.byAgentId.get("881938")?.name).toBe("Acme Agent LLC");
  });

  test("a row is absent only from the index whose key it lacks", () => {
    const noTreasury = entity({ idempotencyKey: "k1", treasury: null, agentId: "1" });
    const noAgent = entity({ idempotencyKey: "k2", treasury: ADDR.treasury, agentId: null });
    const index = indexEntities([noTreasury, noAgent]);
    expect([...index.byTreasury.keys()]).toEqual([ADDR.treasury.toLowerCase()]);
    expect([...index.byAgentId.keys()]).toEqual(["1"]);
  });

  test("A-monitor-9: byProxy indexes the LegalManager, lowercased, and skips rows without one", () => {
    const index = indexEntities([
      entity({ proxy: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }),
      entity({ idempotencyKey: "k2", proxy: null }),
    ]);
    expect(index.byProxy.get("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")?.name).toBe(
      "Acme Agent LLC",
    );
    expect(index.byProxy.size).toBe(1);
  });
});

describe("the OA anchor projection (design §8, audit H3/14)", () => {
  test("A-monitor-10: the four anchor columns reach the monitor — version numbers are not enough", () => {
    // The compromise rule compares the hash the CHAIN scheduled against the hash this deployment
    // says is pending. A version number cannot answer that, which is why these are columns on
    // `entities` and why the read-only projection has to carry them.
    const pending = `0x${"22".repeat(32)}`;
    const anchored = `0x${"11".repeat(32)}`;
    const path = seedMainDb([
      record({
        oaManifestVersion: 2,
        oaManifestAnchoredHash: anchored as `0x${string}`,
        oaManifestPendingHash: pending as `0x${string}`,
        oaManifestPendingVersion: 3,
      }),
    ]);
    const lookup = new SqliteEntityLookup(path);
    expect(lookup.all()[0]).toMatchObject({
      oaManifestVersion: 2,
      oaManifestAnchoredHash: anchored,
      oaManifestPendingHash: pending,
      oaManifestPendingVersion: 3,
    });
    lookup.close();
  });

  test("A-monitor-11: a legacy row reads as nulls, not as a missing column", () => {
    const path = seedMainDb([record()]);
    const lookup = new SqliteEntityLookup(path);
    expect(lookup.all()[0]).toMatchObject({
      oaManifestVersion: null,
      oaManifestPendingHash: null,
      oaManifestPendingVersion: null,
    });
    lookup.close();
  });
});

describe("legal bodies", () => {
  const TENANT = getAddress("0x00000000000000000000000000000000000000a1");
  const FACTORY = getAddress("0x00000000000000000000000000000000000fac70");
  const BODY = getAddress("0x00000000000000000000000000000000b0d1e001");
  const OTHER = getAddress("0x00000000000000000000000000000000000fac71");

  /** A legalbody.db holding one legal body reserved at BODY and one draft with no address. */
  function seedWithLegalBodies(): string {
    const path = seedMainDb([record()]);
    const db = openDatabase(path);
    db.prepare(
      `INSERT INTO companies (company_id, tenant_id, status, provider, environment, name_options, business_purpose, industry_label)
       VALUES ('co_1', ?, 'ready', 'customer', 'sandbox', '["Example Holdings Wyoming DAO LLC"]', 'existing', 'existing')`,
    ).run(TENANT);
    const repo = new SqliteLegalBodyRepository(db);
    const draft = () =>
      repo.create({
        tenantId: TENANT,
        companyId: "co_1",
        chainId: 5042002,
        factory: FACTORY,
        amendmentDelay: 172_800,
      }).legalBodyId;
    const placed = draft();
    expect(repo.freezeAgreement(placed, { hash: `0x${"aa".repeat(32)}`, version: 1 })).toBe(true);
    expect(
      repo.reserve(placed, {
        agentId: "42",
        identityOwner: TENANT,
        linkDigest: `0x${"bb".repeat(32)}`,
        linkDeadline: 1_900_000_000,
        linkSignature: "0x01",
        bodyAddress: BODY,
        observedAtBlock: 1,
        firstCheckAt: 1_800_000_000_000,
      }),
    ).toBe("reserved");
    draft(); // no body address yet: nothing on chain to watch
    db.close();
    return path;
  }

  test("lists the rows that have a body address, with agent id, guardian and factory", () => {
    const lookup = new SqliteEntityLookup(seedWithLegalBodies());
    const bodies = lookup.legalBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.address.toLowerCase()).toBe(BODY.toLowerCase());
    expect(bodies[0]?.agentId).toBe("42");
    expect(bodies[0]?.factory.toLowerCase()).toBe(FACTORY.toLowerCase());
    expect(bodies[0]?.guardian.toLowerCase()).toBe(TENANT.toLowerCase());
    lookup.close();
  });

  test("a database without the legal_bodies table fails the startup probe", () => {
    const path = seedMainDb([record()]);
    const writer = openDatabase(path);
    writer.exec("PRAGMA foreign_keys = OFF; DROP TABLE legal_bodies");
    writer.close();
    const lookup = new SqliteEntityLookup(path);
    expect(() => assertLookupSchema(lookup)).toThrow(/DEPLOY ORDER/);
    lookup.close();
  });

  test("indexLegalBodies unions both sources, lowercased, the API's row first", () => {
    const seenOnly = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb" as Address;
    const index = indexLegalBodies(
      [{ address: BODY, agentId: "42", guardian: TENANT, factory: FACTORY }],
      [
        {
          address: BODY.toLowerCase(),
          factory: OTHER.toLowerCase(),
          agentId: "1",
          guardian: null,
          block: 1n,
          tx: "0x01",
        },
        {
          address: seenOnly.toLowerCase(),
          factory: FACTORY.toLowerCase(),
          agentId: "77",
          guardian: null,
          block: 2n,
          tx: "0x02",
        },
      ],
    );
    expect([...index.keys()]).toEqual([BODY.toLowerCase(), seenOnly.toLowerCase()]);
    expect(index.get(BODY.toLowerCase())).toEqual({
      address: BODY.toLowerCase(),
      factory: FACTORY.toLowerCase(),
      agentId: "42",
      guardian: TENANT,
    });
  });

  test("a factory that is not an address reads as unknown, and a sighting fills it in", () => {
    const recorded = [
      { address: BODY, agentId: null, guardian: TENANT, factory: "not-an-address" },
    ];
    expect(indexLegalBodies(recorded, []).get(BODY.toLowerCase())?.factory).toBeNull();
    const filled = indexLegalBodies(recorded, [
      {
        address: BODY.toLowerCase(),
        factory: OTHER.toLowerCase(),
        agentId: null,
        guardian: null,
        block: 1n,
        tx: "0x01",
      },
    ]);
    expect(filled.get(BODY.toLowerCase())?.factory).toBe(OTHER.toLowerCase());
  });
});
