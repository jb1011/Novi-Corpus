import { expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";

test("the identity tables exist with their guards", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const insert = (over: Record<string, unknown> = {}) =>
    db
      .prepare(
        "INSERT INTO guardian_identity_checks (nullifier, tenant_id, provider, provider_ref, status, started_at, completed_at, expires_at, document_country, watchlist, name_hmac, name_first_ciphertext, name_first_iv, name_last_ciphertext, name_last_iv, name_key_id, environment, synthetic) VALUES (@nullifier, @tenant_id, @provider, @provider_ref, @status, @started_at, @completed_at, @expires_at, @document_country, @watchlist, @name_hmac, @c, @iv, @c, @iv, @kid, @environment, 0)",
      )
      .run({
        nullifier: "n1",
        tenant_id: "0xabc",
        provider: "stripe",
        provider_ref: "vs_1",
        status: "passed",
        started_at: 1,
        completed_at: 2,
        expires_at: 3,
        document_country: "FRA",
        watchlist: "clear",
        name_hmac: "ab",
        c: Buffer.from("x"),
        iv: Buffer.alloc(12),
        kid: "fpk1:0",
        environment: "production",
        ...over,
      });
  expect(insert().changes).toBe(1);
  expect(() => insert({ provider: "other" })).toThrow(/CHECK/); // provider enum
  expect(() => insert({ status: "passed", document_country: null })).toThrow(/CHECK/); // a passed row carries its facts
  expect(() => insert({ status: "failed" })).toThrow(/CHECK/); // a failed row keeps no names
  expect(() => db.prepare("DELETE FROM guardian_identity_checks").run()).toThrow(/append-only/);
  expect(() =>
    db.prepare("UPDATE guardian_identity_checks SET status = 'revoked' WHERE check_id = 1").run(),
  ).toThrow(/only the erasure/);
  expect(
    db
      .prepare(
        "UPDATE guardian_identity_checks SET names_erased_at = 9, name_first_ciphertext = NULL, name_last_ciphertext = NULL, name_full_ciphertext = NULL WHERE check_id = 1",
      )
      .run().changes,
  ).toBe(1);
  expect(() =>
    db
      .prepare(
        "INSERT INTO identity_check_events (check_id, kind, at, actor) VALUES (1, 'guessed', 1, 'system')",
      )
      .run(),
  ).toThrow(/CHECK/);
  // A delete guard fires per row, so the table needs one for the DELETE to meet it.
  db.prepare(
    "INSERT INTO identity_check_events (check_id, kind, at, actor) VALUES (1, 'recorded', 1, 'system')",
  ).run();
  expect(() => db.prepare("DELETE FROM identity_check_events").run()).toThrow(/append-only/);
  db.close();
});

test("an event is never replaced, by its id or by its provider event id", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const event = db.prepare(
    `INSERT OR REPLACE INTO identity_check_events (event_id, check_id, kind, at, actor, provider, provider_event_id)
     VALUES (@event_id, 1, 'recorded', 1, 'system', 'stripe', @provider_event_id)`,
  );
  expect(event.run({ event_id: null, provider_event_id: "evt_1" }).changes).toBe(1);
  expect(() => event.run({ event_id: 1, provider_event_id: "evt_2" })).toThrow(/append-only/);
  expect(() => event.run({ event_id: null, provider_event_id: "evt_1" })).toThrow(/append-only/);
  expect(() => db.prepare("UPDATE identity_check_events SET actor = 'x'").run()).toThrow(
    /append-only/,
  );
  expect(() =>
    db
      .prepare(
        "INSERT INTO identity_check_events (event_id, check_id, kind, at, actor) VALUES (5, 1, 'recorded', 1, 'system')",
      )
      .run(),
  ).toThrow(/in order/);
  expect(
    (db.prepare("SELECT COUNT(*) AS n FROM identity_check_events").get() as { n: number }).n,
  ).toBe(1);
  db.close();
});

test("the names are erased once, and the erasure changes no fact the record compares", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare(
    `INSERT INTO guardian_identity_checks (tenant_id, provider, provider_ref, status, started_at, completed_at, expires_at, document_country, watchlist, name_hmac, name_first_ciphertext, name_first_iv, name_last_ciphertext, name_last_iv, name_key_id, environment, synthetic)
     VALUES ('0xabc', 'sandbox', 'ref_1', 'passed', 1, 2, 3, 'FRA', 'clear', 'ab', x'01', zeroblob(12), x'02', zeroblob(12), 'k', 'sandbox', 1)`,
  ).run();
  const erase = (extra = "") =>
    db
      .prepare(
        `UPDATE guardian_identity_checks SET names_erased_at = 9, name_first_ciphertext = NULL, name_last_ciphertext = NULL, name_full_ciphertext = NULL${extra} WHERE check_id = 1`,
      )
      .run();
  expect(() => erase(", name_hmac = 'cd'")).toThrow(/only the erasure/);
  expect(() => erase(", document_country = 'DEU'")).toThrow(/only the erasure/);
  expect(() => erase(", tenant_id = '0xdef'")).toThrow(/only the erasure/);
  // Every other column is pinned too: who wrote the row, what it decided on, what it was.
  expect(() => erase(", operator = 'someone.else'")).toThrow(/only the erasure/);
  expect(() => erase(", supersedes_check_id = 1")).toThrow(/only the erasure/);
  expect(() => erase(", synthetic = 0")).toThrow(/only the erasure/);
  expect(() => erase(", name_key_id = NULL")).toThrow(/only the erasure/);
  expect(() => erase(", created_at = NULL")).toThrow(/only the erasure/);
  expect(erase().changes).toBe(1);
  expect(() => erase()).toThrow(/only the erasure/); // once
  expect(() =>
    db
      .prepare("UPDATE guardian_identity_checks SET names_erased_at = NULL WHERE check_id = 1")
      .run(),
  ).toThrow(/only the erasure/);
  db.close();
});
