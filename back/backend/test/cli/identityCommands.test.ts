/**
 * The operator's commands over the guardian's identity record: `identity:record`, `identity:accept`,
 * `identity:refuse`, `identity:revoke`, `identity:correct-name`, `identity:show` and
 * `identity:sweep`.
 *
 * Each command opens the database through the configuration, so every test works in a temporary
 * data directory and writes its World rows through its own connection over the same file. With
 * ARC_NETWORK unset the deployment is a sandbox; the production rules are exercised through the
 * exported functions, handed a configuration whose network is mainnet.
 *
 * Every name is a made-up fixture, the PII key a constant test key, and every tenant one of anvil's
 * published test accounts, never a real wallet.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  correctIdentityName,
  recordIdentity,
  reviewIdentity,
  showIdentity,
  sweepIdentityNames,
} from "../../src/cli/identity";
import { buildCli } from "../../src/cli/index";
import { type Config, loadConfig } from "../../src/config/env";
import { nameHmac, parsePiiKey } from "../../src/formation/pii";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  type GuardianIdentityCheck,
  SqliteIdentityRepository,
} from "../../src/persistence/identityRepository";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import {
  ANVIL_ACCOUNT_2,
  ANVIL_ACCOUNT_3,
  ANVIL_ACCOUNT_4,
  recordHuman,
} from "../helpers/customerCompanyFixtures";

const DAY = 86_400_000;
const OPERATOR = "ops.example";
/** The fixture's names as a passport prints them: the surname in capitals. */
const FIRST = "Jean";
const LAST_PRINTED = "DUPONT";
const LAST = "Dupont";
/** The surname in any case: no ops line may hold it. */
const SURNAME = /dupont/i;
const PII_KEY = Buffer.alloc(32, 7).toString("base64");
/** The key a rotation moves to; `PII_KEY` is then the previous one. */
const NEW_PII_KEY = Buffer.alloc(32, 9).toString("base64");
/** The name fingerprint's own secret, as `IDENTITY_NAME_HMAC_KEY` holds it: a constant test key. */
const NAME_HMAC_KEY = Buffer.alloc(32, 5).toString("hex");
const FINGERPRINT = Buffer.from(NAME_HMAC_KEY, "hex");
const RESERVED_SYSTEM =
  "refusing: --operator system is reserved for the retention sweep's own erasures";

/** anvil's published accounts #2, #3 and #4: test keys, never real wallets. */
const guardian = ANVIL_ACCOUNT_2.address;
const second = ANVIL_ACCOUNT_3.address;
const third = ANVIL_ACCOUNT_4.address;

let dir: string;
let db: Database.Database;
let repo: SqliteIdentityRepository;
let store: SqliteWorldStore;
/** Every line written to standard output, the commands' and the ops lines alike. */
let printed: string[];
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "identity-commands-"));
  // The commands find the database through the configuration.
  process.env.DATA_DIR = dir;
  process.env.ARC_TESTNET_RPC_URL = "https://rpc.example";
  process.env.PLATFORM_PRIVATE_KEY = `0x${"a".repeat(64)}`;
  // The names are encrypted under it. A box whose doola block is in sandbox refuses the key, so
  // this deployment has no doola block at all.
  process.env.FORMATION_PII_KEY = PII_KEY;
  // The duplicate check's fingerprint secret, required with the PII key.
  process.env.IDENTITY_NAME_HMAC_KEY = NAME_HMAC_KEY;
  // World ID wired, so the guardian action's rows are read under its action.
  process.env.WORLD_APP_ID = "app_test";
  process.env.WORLD_RP_ID = "rp_test";
  process.env.WORLD_RP_SIGNING_KEY = `0x${"1".repeat(64)}`;
  for (const name of [
    "ARC_NETWORK",
    "DOOLA_API_KEY",
    "DOOLA_WEBHOOK_SECRET",
    "DOOLA_ENVIRONMENT",
    "FORMATION_PII_KEY_PREVIOUS",
    "IDENTITY_REVERIFY_YEARS",
    "IDENTITY_UNUSED_RETENTION_DAYS",
    "IDENTITY_FAILED_RETENTION_DAYS",
    "SCREENING_BLOCKED_COUNTRIES",
    "WORLD_ACTION",
    "WORLD_ENVIRONMENT",
  ])
    Reflect.deleteProperty(process.env, name);
  db = openDatabase(join(dir, "legalbody.db"));
  migrate(db);
  repo = new SqliteIdentityRepository(db);
  store = new SqliteWorldStore(db);
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────

/** A verified human's World row for the tenant; a waiver row with `credential = "waiver"`. */
function human(tenantId: `0x${string}`, nullifier: string, credential = "proof_of_human"): void {
  recordHuman(store, tenantId, nullifier, Date.now(), credential);
}

/** The deployment's configuration as the commands read it, on another network if asked. */
function config(over: Partial<Config> = {}): Config {
  return { ...loadConfig(), ...over };
}

type Options = Record<string, string | null>;

/** The options as a command line; an option given as null is left out. */
const flags = (options: Options): string[] =>
  Object.entries(options).flatMap(([name, value]) => (value === null ? [] : [name, value]));

const RECORD_DEFAULTS: Options = {
  "--provider": "stripe",
  "--provider-ref": "vs_test_0001",
  "--result": "passed",
  "--name-first": FIRST,
  "--name-last": LAST_PRINTED,
  "--country": "FRA",
  "--document-type": "passport",
  "--liveness": "passed",
  "--watchlist": "clear",
  "--operator": OPERATOR,
  "--expect-latest": "none",
};

function recordLine(tenantId: string, over: Options = {}, extra: string[] = ["--yes"]): string[] {
  return ["identity:record", tenantId, ...flags({ ...RECORD_DEFAULTS, ...over }), ...extra];
}

/** The options of `recordIdentity`, as commander hands them over. */
const recordOpts = (over: Record<string, unknown> = {}) => ({
  provider: "stripe",
  providerRef: "vs_test_0001",
  result: "passed",
  nameFirst: FIRST,
  nameLast: LAST_PRINTED,
  country: "FRA",
  documentType: "passport",
  liveness: "passed",
  watchlist: "clear",
  operator: OPERATOR,
  expectLatest: "none",
  yes: true,
  ...over,
});

const REASON = "Checked against the provider's session and the sanctions search.";

function decisionLine(
  command: string,
  tenantId: string,
  expectLatest: number | string,
  reasonCode: string,
  over: Options = {},
  yes = true,
): string[] {
  return [
    command,
    tenantId,
    ...flags({
      "--operator": OPERATOR,
      "--expect-latest": String(expectLatest),
      "--reason-code": reasonCode,
      "--reason": REASON,
      ...over,
    }),
    ...(yes ? ["--yes"] : []),
  ];
}

const noChain = () => {
  throw new Error("this command must not build a chain context");
};

const isOpsLine = (line: string): boolean => {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null && "opslog" in parsed;
  } catch {
    return false;
  }
};

interface Run<T> {
  /** The one JSON object the command printed. */
  output: T;
  /** The ops lines it wrote, parsed. */
  ops: Record<string, unknown>[];
}

async function run<T = Record<string, unknown>>(args: string[]): Promise<Run<T>> {
  const from = printed.length;
  await buildCli(noChain).parseAsync(["node", "cli", ...args]);
  const lines = printed.slice(from);
  const outputs = lines.filter((line) => !isOpsLine(line));
  expect(outputs).toHaveLength(1);
  return {
    output: JSON.parse(outputs[0] as string) as T,
    ops: lines.filter(isOpsLine).map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** The refusal's message. A refusal writes no ops line. */
async function refusal(args: string[]): Promise<string> {
  const from = printed.length;
  let message: string | undefined;
  try {
    await buildCli(noChain).parseAsync(["node", "cli", ...args]);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  if (message === undefined) throw new Error(`expected ${args[0]} to be refused`);
  expect(printed.slice(from).filter(isOpsLine)).toEqual([]);
  return message;
}

/** The message `fn` throws. */
function thrownBy(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

interface Recorded {
  recorded: true;
  checkId: number;
  tenantId: string;
  status: string;
  reviewReasons: string[];
  expiresAt: number | null;
  duplicateOf?: number[];
}
interface Shown {
  tenantId: string;
  state: string;
  latestCheckId: number | null;
  expectLatest: string;
  latest: {
    checkId: number;
    status: string;
    names: { first: string; last: string; full: string | null } | null;
  } | null;
  history: {
    checkId: number;
    status: string;
    reviewReasons: string[];
    events: { kind: string; actor: string; reasonCode: string | null }[];
  }[];
}

function latestOf(tenantId: string): GuardianIdentityCheck {
  const latest = repo.latest(tenantId);
  if (latest === undefined) throw new Error("no identity row");
  return latest;
}

/** A recorded check, through the command; returns its check id. */
async function recorded(tenantId: string, over: Options = {}): Promise<Recorded> {
  return (await run<Recorded>(recordLine(tenantId, over))).output;
}

// ── identity:record ───────────────────────────────────────────────────────────────────────────

describe("identity:record", () => {
  test("record without --yes writes nothing and prints the plan", async () => {
    human(guardian, "1001");

    const { output, ops } = await run<{
      recorded: boolean;
      latestCheckId: number | null;
      wouldRecord: { status: string; reviewReasons: string[]; provider: string };
      next: string;
    }>(recordLine(guardian, {}, []));

    expect(output.recorded).toBe(false);
    expect(output.latestCheckId).toBeNull();
    expect(output.wouldRecord).toMatchObject({
      status: "passed",
      reviewReasons: [],
      provider: "stripe",
    });
    expect(output.next).toMatch(/--yes/);
    expect(JSON.stringify(output)).not.toMatch(SURNAME);
    expect(ops).toEqual([]);
    expect(repo.list(guardian)).toEqual([]);
  });

  test("record passed stores passed with expires_at three calendar years later (2026-11-10T12:00Z → 2029-11-10T12:00Z)", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 10, 10, 13) });
    human(guardian, "1001");

    const { output, ops } = await run<Recorded>(
      recordLine(guardian, { "--completed-at": "2026-11-10T12:00Z" }),
    );

    expect(output).toMatchObject({
      recorded: true,
      tenantId: guardian,
      status: "passed",
      reviewReasons: [],
      expiresAt: Date.UTC(2029, 10, 10, 12),
    });
    const row = latestOf(guardian);
    expect(row).toMatchObject({
      checkId: output.checkId,
      status: "passed",
      completedAt: Date.UTC(2026, 10, 10, 12),
      expiresAt: Date.UTC(2029, 10, 10, 12),
      nullifier: "1001",
      provider: "stripe",
      providerRef: "vs_test_0001",
      documentCountry: "FRA",
      documentType: "passport",
      documentExpired: false,
      liveness: "passed",
      watchlist: "clear",
      operator: OPERATOR,
      operatorOsUser: userInfo().username,
    });
    expect(repo.events(output.checkId)).toMatchObject([
      { kind: "recorded", actor: OPERATOR, reasonCode: null },
    ]);
    expect(ops).toEqual([
      expect.objectContaining({
        opslog: "identity_recorded",
        checkId: output.checkId,
        tenant: guardian.slice(0, 10),
        provider: "stripe",
        status: "passed",
        watchlist: "clear",
        country: "FRA",
        operator: OPERATOR,
      }),
    ]);
  });

  test("record refuses a completion time in the future, or one that is not a time with its zone", async () => {
    human(guardian, "1001");
    const tomorrow = new Date(Date.now() + DAY).toISOString();

    expect(await refusal(recordLine(guardian, { "--completed-at": tomorrow }))).toMatch(
      /^refusing: --completed-at is in the future/,
    );
    expect(await refusal(recordLine(guardian, { "--completed-at": "2026-11-10 12:00" }))).toMatch(
      /^refusing: --completed-at must be an ISO-8601 time/,
    );
    expect(await refusal(recordLine(guardian, { "--completed-at": "2026-02-30T12:00Z" }))).toMatch(
      /^refusing: --completed-at must be an ISO-8601 time/,
    );
    expect(repo.list(guardian)).toEqual([]);
  });

  test('record with a watchlist hit stores needs_review with ["watchlist_hit"]', async () => {
    human(guardian, "1001");

    const output = await recorded(guardian, { "--watchlist": "hit" });

    expect(output).toMatchObject({ status: "needs_review", reviewReasons: ["watchlist_hit"] });
    expect(latestOf(guardian)).toMatchObject({
      status: "needs_review",
      reviewReasons: ["watchlist_hit"],
    });
  });

  test("record with an expired document and a blocked country stores needs_review with both codes", async () => {
    human(guardian, "1001");

    const output = await run<Recorded>(
      recordLine(guardian, { "--country": "prk" }, ["--document-expired", "--yes"]),
    );

    expect(output.output).toMatchObject({
      status: "needs_review",
      reviewReasons: ["document_expired", "country_blocked"],
    });
    expect(latestOf(guardian)).toMatchObject({ documentCountry: "PRK", documentExpired: true });
  });

  test("record with --result needs_review stores the provider's flag", async () => {
    human(guardian, "1001");

    const output = await recorded(guardian, { "--result": "needs_review" });

    expect(output).toMatchObject({ status: "needs_review", reviewReasons: ["provider_flag"] });
  });

  test('record with an all-capitals surname stores the title-cased name (identity:show prints "Dupont")', async () => {
    human(guardian, "1001");
    await recorded(guardian, { "--name-full": "JEAN PIERRE DUPONT" });

    const { output, ops } = await run<Shown>(["identity:show", guardian]);

    expect(output.state).toBe("verified");
    expect(output.latest?.names).toEqual({
      first: FIRST,
      last: LAST,
      full: "Jean Pierre Dupont",
    });
    // The only command that prints a name writes no ops line.
    expect(ops).toEqual([]);
  });

  test('record with a CJK name stores needs_review with ["name_rule_failed"]', async () => {
    human(guardian, "1001");

    const output = await recorded(guardian, { "--name-first": "伟", "--name-last": "王" });

    expect(output).toMatchObject({ status: "needs_review", reviewReasons: ["name_rule_failed"] });
  });

  test('record with an empty first name stores needs_review with ["name_rule_failed"]', async () => {
    human(guardian, "1001");

    const output = await recorded(guardian, { "--name-first": "  " });

    expect(output).toMatchObject({ status: "needs_review", reviewReasons: ["name_rule_failed"] });
  });

  test('record with the same hmac and country as another tenant\'s passed row stores needs_review with ["duplicate_identity"]', async () => {
    human(guardian, "1001");
    human(second, "1002");
    const first = await recorded(guardian);

    const { output } = await run<Recorded>(
      // The same person, the surname typed in another case: the hmac reads the normalised name.
      recordLine(second, { "--name-last": LAST, "--provider-ref": "vs_test_0002" }),
    );

    expect(output).toMatchObject({
      status: "needs_review",
      reviewReasons: ["duplicate_identity"],
      duplicateOf: [first.checkId],
    });
    expect(JSON.stringify(output)).not.toMatch(SURNAME);
  });

  test("a PII key rotation changes no fingerprint: a pass sealed under the old key is found as a duplicate after it, the old key no longer configured", async () => {
    human(guardian, "1001");
    human(second, "1002");
    const first = await recorded(guardian);
    expect(latestOf(guardian).nameHmac).toBe(nameHmac(FINGERPRINT, FIRST, LAST));
    // The rotation, and the old key dropped altogether: the lookup reads no PII key.
    process.env.FORMATION_PII_KEY = NEW_PII_KEY;

    const { output } = await run<Recorded>(
      recordLine(second, { "--name-last": LAST, "--provider-ref": "vs_test_0002" }),
    );

    expect(output).toMatchObject({
      status: "needs_review",
      reviewReasons: ["duplicate_identity"],
      duplicateOf: [first.checkId],
    });
    // One fingerprint per name, before and after the rotation.
    expect(latestOf(second).nameHmac).toBe(latestOf(guardian).nameHmac);
    expect(latestOf(second).names?.keyId).toBe(parsePiiKey(NEW_PII_KEY, "FORMATION_PII_KEY").id);
  });

  test("record with --expect-latest none when a row exists refuses", async () => {
    human(guardian, "1001");
    const first = await recorded(guardian, { "--watchlist": "hit" });

    expect(await refusal(recordLine(guardian, { "--provider-ref": "vs_test_0002" }))).toBe(
      `refusing: the latest identity check of ${guardian} is ${first.checkId}, not none: another operator has written since, or this command came from the shell history. Run identity:show ${guardian} and decide again`,
    );
    expect(repo.list(guardian)).toHaveLength(1);
  });

  test("the same record line replayed after success refuses (expect-latest is stale)", async () => {
    human(guardian, "1001");
    const line = recordLine(guardian);
    await run(line);

    expect(await refusal(line)).toMatch(
      /^refusing: the latest identity check of .* is 1, not none/,
    );
    expect(repo.list(guardian)).toHaveLength(1);
  });

  test("a renewal pass on a verified guardian is recorded, the guardian stays verified and the expiry moves", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2027, 5, 1, 13) });
    human(guardian, "1001");
    const first = await recorded(guardian, { "--completed-at": "2026-11-10T12:00Z" });
    expect(first.expiresAt).toBe(Date.UTC(2029, 10, 10, 12));

    const renewal = await recorded(guardian, {
      "--provider-ref": "vs_test_0002",
      "--completed-at": "2027-06-01T12:00Z",
      "--expect-latest": String(first.checkId),
    });

    expect(renewal).toMatchObject({
      status: "passed",
      reviewReasons: [],
      // From the new completion, three calendar years on.
      expiresAt: Date.UTC(2030, 5, 1, 12),
    });
    expect(latestOf(guardian)).toMatchObject({
      checkId: renewal.checkId,
      providerRef: "vs_test_0002",
    });
    expect(showIdentity(db, config(), guardian)).toMatchObject({
      state: "verified",
      latestCheckId: renewal.checkId,
    });
  });

  test("a renewal pass is held to every rule of a pass, the duplicate check included", async () => {
    human(guardian, "1001");
    human(second, "1002");
    const held = await recorded(guardian);
    const own = await recorded(second, { "--name-first": "Ana", "--name-last": "Example" });

    // The second guardian renews under the name another account's current pass holds.
    const renewal = await recorded(second, {
      "--provider-ref": "vs_test_0002",
      "--expect-latest": String(own.checkId),
    });

    expect(renewal).toMatchObject({
      status: "needs_review",
      reviewReasons: ["duplicate_identity"],
      duplicateOf: [held.checkId],
    });
  });

  test("a failed or needs_review result on a verified guardian is refused", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 10, 10, 13) });
    human(guardian, "1001");
    const first = await recorded(guardian, { "--completed-at": "2026-11-10T12:00Z" });
    const VERIFIED =
      "refusing: the guardian is verified until 2029-11-10; a renewal records --result passed; use identity:correct-name for a name, or identity:revoke first for a failed check or a review";

    expect(
      await refusal(
        recordLine(guardian, {
          "--provider-ref": "vs_test_0002",
          "--result": "needs_review",
          "--expect-latest": String(first.checkId),
        }),
      ),
    ).toBe(VERIFIED);
    expect(
      await refusal(
        recordLine(guardian, {
          "--provider-ref": "vs_test_0002",
          "--result": "failed",
          "--name-first": null,
          "--name-last": null,
          "--watchlist": null,
          "--reason-code": "selfie_mismatch",
          "--reason": REASON,
          "--expect-latest": String(first.checkId),
        }),
      ),
    ).toBe(VERIFIED);
    expect(repo.list(guardian)).toHaveLength(1);
  });

  test("record failed with --name-first refuses", async () => {
    human(guardian, "1001");

    expect(
      await refusal(
        recordLine(guardian, {
          "--result": "failed",
          "--name-last": null,
          "--reason-code": "other",
          "--reason": REASON,
        }),
      ),
    ).toMatch(/^refusing: --name-first is not taken with --result failed/);
    expect(repo.list(guardian)).toEqual([]);
  });

  test("record failed stores failed without names, its reason code on the event; without --reason-code it refuses", async () => {
    human(guardian, "1001");
    const failedLine = (over: Options) =>
      recordLine(guardian, {
        "--result": "failed",
        "--name-first": null,
        "--name-last": null,
        "--watchlist": null,
        "--reason-code": "document_expired",
        "--reason": REASON,
        ...over,
      });

    expect(await refusal(failedLine({ "--reason-code": null }))).toBe(
      "refusing: --result failed needs --reason-code",
    );
    const { output } = await run<Recorded>(failedLine({}));

    expect(output).toMatchObject({ status: "failed", reviewReasons: [], expiresAt: null });
    const row = latestOf(guardian);
    expect(row).toMatchObject({ status: "failed", names: null, nameHmac: null });
    expect(repo.events(row.checkId)).toMatchObject([
      { kind: "recorded", reasonCode: "document_expired", reason: REASON },
    ]);
  });

  test("record without a World row for the guardian action refuses", async () => {
    expect(await refusal(recordLine(guardian))).toBe(
      "refusing: the account has no World ID verification",
    );
  });

  test("a tenant id that is not an address is refused; a lower-case one is recorded under its checksummed spelling", async () => {
    human(guardian, "1001");

    expect(await refusal(recordLine("not-an-address"))).toBe(
      "refusing: <tenantId> must be a wallet address",
    );
    const { output } = await run<Recorded>(recordLine(guardian.toLowerCase()));

    expect(output.tenantId).toBe(guardian);
    expect(latestOf(guardian).checkId).toBe(output.checkId);
  });

  test("on a sandbox database record writes synthetic = 1", async () => {
    human(guardian, "1001");
    await recorded(guardian);

    expect(db.prepare("SELECT environment, synthetic FROM guardian_identity_checks").all()).toEqual(
      [{ environment: "sandbox", synthetic: 1 }],
    );
  });

  test("on production a tenant whose World row is a waiver is refused", () => {
    human(guardian, "1001", "waiver");
    const production = config({ arcNetwork: "mainnet" });

    expect(thrownBy(() => recordIdentity(db, production, guardian, recordOpts()))).toBe(
      "refusing: the account has no production World ID verification",
    );
    expect(repo.list(guardian)).toEqual([]);
  });

  test("on production a verified human's check is recorded as production, not synthetic; the sandbox provider is refused", () => {
    human(guardian, "1001");
    const production = config({ arcNetwork: "mainnet" });

    expect(
      thrownBy(() => recordIdentity(db, production, guardian, recordOpts({ provider: "sandbox" }))),
    ).toBe("refusing: --provider sandbox is not taken on production");
    recordIdentity(db, production, guardian, recordOpts());

    expect(latestOf(guardian)).toMatchObject({
      status: "passed",
      environment: "production",
      synthetic: false,
      nullifier: "1001",
    });
  });

  test("on production a passed check needs the sanctions search and the face match; a review does not", () => {
    human(guardian, "1001");
    const production = config({ arcNetwork: "mainnet" });
    const NEEDS_SEARCH =
      "refusing: on production a passed check needs the sanctions search: --watchlist clear or hit";
    const NEEDS_LIVENESS = "refusing: on production a passed check needs --liveness passed";

    expect(
      thrownBy(() =>
        recordIdentity(db, production, guardian, recordOpts({ watchlist: "not_run" })),
      ),
    ).toBe(NEEDS_SEARCH);
    for (const liveness of [undefined, "failed", "not_run"])
      expect(
        thrownBy(() => recordIdentity(db, production, guardian, recordOpts({ liveness }))),
      ).toBe(NEEDS_LIVENESS);
    expect(repo.list(guardian)).toEqual([]);

    recordIdentity(
      db,
      production,
      guardian,
      recordOpts({ result: "needs_review", liveness: "not_run", watchlist: "not_run" }),
    );
    expect(latestOf(guardian)).toMatchObject({
      status: "needs_review",
      reviewReasons: ["provider_flag"],
    });
  });

  test("on a sandbox deployment a passed check needs neither", async () => {
    human(guardian, "1001");

    const output = await recorded(guardian, { "--liveness": null, "--watchlist": "not_run" });

    expect(output).toMatchObject({ status: "passed", reviewReasons: [] });
  });

  test("record failed takes only a failure reason code", async () => {
    human(guardian, "1001");
    const failedLine = (reasonCode: string) =>
      recordLine(guardian, {
        "--result": "failed",
        "--name-first": null,
        "--name-last": null,
        "--reason-code": reasonCode,
        "--reason": "stripe requires_input: selfie_face_mismatch",
      });

    expect(await refusal(failedLine("watchlist_confirmed"))).toBe(
      "refusing: --reason-code must be one of document_unverified, document_expired, selfie_mismatch, consent_declined, abandoned, other",
    );
    await run(failedLine("selfie_mismatch"));

    expect(repo.events(latestOf(guardian).checkId)).toMatchObject([
      { kind: "recorded", reasonCode: "selfie_mismatch" },
    ]);
  });

  test("no operator may write under the name the sweep writes under", async () => {
    human(guardian, "1001");

    expect(await refusal(recordLine(guardian, { "--operator": "system" }))).toBe(RESERVED_SYSTEM);
    const review = await recorded(guardian, { "--watchlist": "hit" });
    expect(
      await refusal(
        decisionLine("identity:refuse", guardian, review.checkId, "watchlist_confirmed", {
          "--operator": "system",
        }),
      ),
    ).toBe(RESERVED_SYSTEM);
  });

  test("every command that encrypts or decrypts refuses without FORMATION_PII_KEY", async () => {
    human(guardian, "1001");
    await recorded(guardian, { "--watchlist": "hit" });
    Reflect.deleteProperty(process.env, "FORMATION_PII_KEY");
    const NO_KEY = "refusing: FORMATION_PII_KEY is not set on this deployment";

    expect(await refusal(recordLine(second))).toBe(NO_KEY);
    expect(await refusal(["identity:show", guardian])).toBe(NO_KEY);
    expect(
      await refusal(decisionLine("identity:accept", guardian, 1, "watchlist_false_positive")),
    ).toBe(NO_KEY);
    expect(
      await refusal(
        decisionLine("identity:correct-name", guardian, 1, "transliteration", {
          "--name-first": FIRST,
          "--name-last": LAST,
        }),
      ),
    ).toBe(NO_KEY);
  });
});

test("the commands that fingerprint a name refuse without the fingerprint key in the configuration", () => {
  human(guardian, "1001");
  // A configuration the boot would refuse: the PII key without the fingerprint key.
  const loaded = config();
  const noFingerprint = config({ identity: { ...loaded.identity, nameHmacKey: undefined } });

  expect(thrownBy(() => recordIdentity(db, noFingerprint, guardian, recordOpts()))).toBe(
    "refusing: IDENTITY_NAME_HMAC_KEY is not set on this deployment",
  );
  expect(repo.list(guardian)).toEqual([]);
});

// ── identity:accept, identity:refuse, identity:revoke ─────────────────────────────────────────

describe("the decisions", () => {
  test("accept from needs_review appends passed and show reads verified", async () => {
    human(guardian, "1001");
    const review = await recorded(guardian, { "--watchlist": "hit" });

    const { output, ops } = await run<Recorded & { supersedesCheckId: number }>(
      decisionLine("identity:accept", guardian, review.checkId, "watchlist_false_positive"),
    );

    expect(output).toMatchObject({
      recorded: true,
      status: "passed",
      supersedesCheckId: review.checkId,
      reviewReasons: [],
    });
    const before = repo.findById(review.checkId) as GuardianIdentityCheck;
    const row = latestOf(guardian);
    expect(row).toMatchObject({
      status: "passed",
      supersedesCheckId: review.checkId,
      providerRef: before.providerRef,
      completedAt: before.completedAt,
      expiresAt: before.expiresAt,
      documentCountry: "FRA",
      watchlist: "hit",
      nameHmac: before.nameHmac,
      operator: OPERATOR,
    });
    // Sealed again: a new IV, the same names.
    expect(row.names?.first.iv.equals(before.names?.first.iv as Buffer)).toBe(false);
    expect(repo.events(row.checkId)).toMatchObject([
      { kind: "accepted", actor: OPERATOR, reasonCode: "watchlist_false_positive", reason: REASON },
    ]);
    expect(ops).toEqual([
      expect.objectContaining({
        opslog: "identity_accepted",
        checkId: row.checkId,
        supersedes: review.checkId,
        status: "passed",
        reasonCode: "watchlist_false_positive",
        operator: OPERATOR,
      }),
    ]);

    const shown = (await run<Shown>(["identity:show", guardian])).output;
    expect(shown.state).toBe("verified");
    expect(shown.latest?.names).toEqual({ first: FIRST, last: LAST, full: null });
    expect(shown.history.map((h) => [h.checkId, h.status, h.reviewReasons])).toEqual([
      [review.checkId, "needs_review", ["watchlist_hit"]],
      [row.checkId, "passed", []],
    ]);
  });

  test("accept refuses a reason code outside the list, and a latest row that is not a review", async () => {
    human(guardian, "1001");
    const review = await recorded(guardian, { "--watchlist": "hit" });

    expect(
      await refusal(decisionLine("identity:accept", guardian, review.checkId, "fraud")),
    ).toMatch(/^refusing: --reason-code must be one of provider_flag_cleared, /);
    await run(
      decisionLine("identity:accept", guardian, review.checkId, "watchlist_false_positive"),
    );
    expect(
      await refusal(
        decisionLine("identity:accept", guardian, review.checkId + 1, "watchlist_false_positive"),
      ),
    ).toBe(
      `refusing: the latest identity check of ${guardian} is passed: only a needs_review check is accepted`,
    );
  });

  test("accept is refused while another account's passed check holds the same name and document country", async () => {
    human(guardian, "1001");
    human(second, "1002");
    const review = await recorded(guardian, { "--watchlist": "hit" });
    // A review is no one's verified identity, so the second account passes clean.
    const clean = await recorded(second, { "--provider-ref": "vs_test_0002" });
    expect(clean.status).toBe("passed");

    const refused = await refusal(
      decisionLine("identity:accept", guardian, review.checkId, "watchlist_false_positive"),
    );

    expect(refused).toBe(
      `refusing: another account holds a verified identity with the same name and document country (checks ${clean.checkId}): refuse this one with duplicate_identity, or revoke the other first`,
    );
    expect(refused).not.toMatch(SURNAME);
    expect(latestOf(guardian).checkId).toBe(review.checkId);
    await run(decisionLine("identity:refuse", guardian, review.checkId, "duplicate_identity"));
    expect(latestOf(guardian).status).toBe("failed");
  });

  test("accept and refuse each take only their own decision codes", async () => {
    human(guardian, "1001");
    const review = await recorded(guardian, { "--watchlist": "hit" });

    expect(
      await refusal(
        decisionLine("identity:accept", guardian, review.checkId, "watchlist_confirmed"),
      ),
    ).toBe(
      "refusing: --reason-code must be one of provider_flag_cleared, watchlist_false_positive, other",
    );
    expect(
      await refusal(
        decisionLine("identity:refuse", guardian, review.checkId, "watchlist_false_positive"),
      ),
    ).toBe(
      "refusing: --reason-code must be one of watchlist_confirmed, country_blocked, document_expired, duplicate_identity, name_rule_failed, other",
    );
    expect(repo.list(guardian)).toHaveLength(1);
  });

  test("accept after a key rotation seals the names under the new key, and the fingerprint is the same", async () => {
    human(guardian, "1001");
    const review = await recorded(guardian, { "--watchlist": "hit" });
    const before = latestOf(guardian);
    const oldKey = parsePiiKey(PII_KEY, "FORMATION_PII_KEY");
    const newKey = parsePiiKey(NEW_PII_KEY, "FORMATION_PII_KEY");
    expect(before.names?.keyId).toBe(oldKey.id);
    process.env.FORMATION_PII_KEY = NEW_PII_KEY;
    process.env.FORMATION_PII_KEY_PREVIOUS = PII_KEY;

    await run(
      decisionLine("identity:accept", guardian, review.checkId, "watchlist_false_positive"),
    );

    const row = latestOf(guardian);
    expect(row.names?.keyId).toBe(newKey.id);
    // Computed again from the decrypted names, under the fingerprint secret: the same digest.
    expect(row.nameHmac).toBe(nameHmac(FINGERPRINT, FIRST, LAST));
    expect(row.nameHmac).toBe(before.nameHmac);
    expect((await run<Shown>(["identity:show", guardian])).output).toMatchObject({
      state: "verified",
      latest: { names: { first: FIRST, last: LAST, full: null } },
    });
  });

  test("accept after a key rotation finds a pass sealed under the previous key as a duplicate: the fingerprint did not change", async () => {
    human(guardian, "1001");
    human(second, "1002");
    // The review comes first, so the other account's pass is recorded clean.
    const review = await recorded(second, {
      "--watchlist": "hit",
      "--provider-ref": "vs_test_0002",
    });
    const held = await recorded(guardian);
    expect(held.status).toBe("passed");
    process.env.FORMATION_PII_KEY = NEW_PII_KEY;
    process.env.FORMATION_PII_KEY_PREVIOUS = PII_KEY;

    expect(
      await refusal(
        decisionLine("identity:accept", second, review.checkId, "watchlist_false_positive"),
      ),
    ).toMatch(
      new RegExp(
        `^refusing: another account holds a verified identity .*\\(checks ${held.checkId}\\)`,
      ),
    );
    expect(latestOf(second).checkId).toBe(review.checkId);
  });

  test("refuse appends failed without names", async () => {
    human(guardian, "1001");
    const review = await recorded(guardian, { "--watchlist": "hit" });

    const { output } = await run<Recorded>(
      decisionLine("identity:refuse", guardian, review.checkId, "watchlist_confirmed"),
    );

    expect(output).toMatchObject({ status: "failed" });
    const row = latestOf(guardian);
    expect(row).toMatchObject({
      status: "failed",
      supersedesCheckId: review.checkId,
      names: null,
      nameHmac: null,
      expiresAt: null,
    });
    expect(repo.events(row.checkId)).toMatchObject([
      { kind: "refused", reasonCode: "watchlist_confirmed" },
    ]);
    expect((await run<Shown>(["identity:show", guardian])).output).toMatchObject({
      state: "failed",
      latest: { names: null },
    });
  });

  test("revoke from passed appends revoked", async () => {
    human(guardian, "1001");
    const passed = await recorded(guardian);

    const { output, ops } = await run<Recorded>(
      decisionLine("identity:revoke", guardian, passed.checkId, "fraud"),
    );

    expect(output).toMatchObject({ status: "revoked" });
    expect(latestOf(guardian)).toMatchObject({
      status: "revoked",
      supersedesCheckId: passed.checkId,
      names: null,
    });
    expect(ops).toEqual([
      expect.objectContaining({ opslog: "identity_revoked", reasonCode: "fraud" }),
    ]);
    // Revoked: a new check may now be recorded.
    expect(
      await refusal(decisionLine("identity:revoke", guardian, passed.checkId + 1, "fraud")),
    ).toBe(
      `refusing: the latest identity check of ${guardian} is revoked: only a passed check is revoked`,
    );
  });

  test("a decision without --yes writes nothing", async () => {
    human(guardian, "1001");
    const review = await recorded(guardian, { "--watchlist": "hit" });

    const { output, ops } = await run<{ recorded: boolean; wouldRecord: { status: string } }>(
      decisionLine("identity:refuse", guardian, review.checkId, "watchlist_confirmed", {}, false),
    );

    expect(output).toMatchObject({ recorded: false, wouldRecord: { status: "failed" } });
    expect(ops).toEqual([]);
    expect(repo.list(guardian)).toHaveLength(1);
  });
});

// ── identity:correct-name ─────────────────────────────────────────────────────────────────────

describe("identity:correct-name", () => {
  test("correct-name from a name_rule_failed review lands passed", async () => {
    human(guardian, "1001");
    const review = await recorded(guardian, { "--name-first": "伟", "--name-last": "王" });

    const { output } = await run<Recorded>(
      decisionLine("identity:correct-name", guardian, review.checkId, "other_script", {
        "--name-first": "Wei",
        "--name-last": "WANG",
      }),
    );

    expect(output).toMatchObject({ status: "passed", reviewReasons: [] });
    const row = latestOf(guardian);
    expect(row.nameHmac).not.toBe(
      (repo.findById(review.checkId) as GuardianIdentityCheck).nameHmac,
    );
    expect(repo.events(row.checkId)).toMatchObject([
      { kind: "name_corrected", reasonCode: "other_script" },
    ]);
    expect((await run<Shown>(["identity:show", guardian])).output.latest?.names).toEqual({
      first: "Wei",
      last: "Wang",
      full: null,
    });
  });

  test("correct-name keeps the review's other reasons, and refuses a name that breaks the rule", async () => {
    human(guardian, "1001");
    const review = await recorded(guardian, {
      "--name-first": "伟",
      "--name-last": "王",
      "--watchlist": "hit",
    });

    expect(
      await refusal(
        decisionLine("identity:correct-name", guardian, review.checkId, "other_script", {
          "--name-first": "Wei",
          "--name-last": "Wang3",
        }),
      ),
    ).toMatch(/^refusing: the corrected name breaks the name rule: name /);
    const { output } = await run<Recorded>(
      decisionLine("identity:correct-name", guardian, review.checkId, "other_script", {
        "--name-first": "Wei",
        "--name-last": "Wang",
      }),
    );

    expect(output).toMatchObject({ status: "needs_review", reviewReasons: ["watchlist_hit"] });
  });

  test("correct-name to a name another tenant's passed check holds lands needs_review with duplicate_identity", async () => {
    human(guardian, "1001");
    human(second, "1002");
    await recorded(guardian);
    const typo = await recorded(second, {
      "--name-last": "Dupond",
      "--provider-ref": "vs_test_0002",
    });

    const { output } = await run<Recorded>(
      decisionLine("identity:correct-name", second, typo.checkId, "transliteration", {
        "--name-first": FIRST,
        "--name-last": LAST,
      }),
    );

    expect(output).toMatchObject({ status: "needs_review", reviewReasons: ["duplicate_identity"] });
  });

  test("correct-name after a key rotation finds a pass sealed under the old key as a duplicate, the old key no longer configured", async () => {
    human(guardian, "1001");
    human(second, "1002");
    await recorded(guardian);
    const typo = await recorded(second, {
      "--name-last": "Dupond",
      "--provider-ref": "vs_test_0002",
    });
    // The rotation, the old key dropped: correct-name decrypts nothing, and the lookup reads no
    // PII key.
    process.env.FORMATION_PII_KEY = NEW_PII_KEY;

    const { output } = await run<Recorded>(
      decisionLine("identity:correct-name", second, typo.checkId, "transliteration", {
        "--name-first": FIRST,
        "--name-last": LAST,
      }),
    );

    expect(output).toMatchObject({ status: "needs_review", reviewReasons: ["duplicate_identity"] });
  });

  test("correct-name without --name-full keeps no full name", async () => {
    human(guardian, "1001");
    const passed = await recorded(guardian, { "--name-full": "JEAN PIERRE DUPONT" });

    await run(
      decisionLine("identity:correct-name", guardian, passed.checkId, "transliteration", {
        "--name-first": "Jean-Pierre",
        "--name-last": LAST,
      }),
    );

    expect((await run<Shown>(["identity:show", guardian])).output.latest?.names).toEqual({
      first: "Jean-Pierre",
      last: LAST,
      full: null,
    });
  });

  test("correct-name refuses a check whose names were erased", async () => {
    human(guardian, "1001");
    const passed = await recorded(guardian);
    repo.eraseNames(passed.checkId, Date.now(), {
      kind: "names_erased",
      at: Date.now(),
      actor: "system",
      actorOsUser: null,
      reasonCode: "unused",
      reason: null,
    });

    expect(
      await refusal(
        decisionLine("identity:correct-name", guardian, passed.checkId, "transliteration", {
          "--name-first": FIRST,
          "--name-last": LAST,
        }),
      ),
    ).toBe(
      `refusing: the names of check ${passed.checkId} were erased: record a new check instead`,
    );
  });
});

// ── the production pass, however the row is built ─────────────────────────────────────────────

describe("on production a passed row needs the face match, the sanctions search and the name rule, however it is built", () => {
  const production = () => config({ arcNetwork: "mainnet" });
  /** The options of a decision, as commander hands them over. */
  const decided = (expectLatest: number, reasonCode: string) => ({
    operator: OPERATOR,
    expectLatest: String(expectLatest),
    reasonCode,
    reason: REASON,
    yes: true,
  });
  const NO_FACE_MATCH =
    "refusing: on production a passed check needs the face match (--liveness passed), and this check has none: refuse it with identity:refuse and record a new check";
  const NO_SEARCH =
    "refusing: on production a passed check needs the sanctions search (--watchlist clear or hit), and this check has none: refuse it with identity:refuse and record a new check";

  test("accept of a production review recorded with --liveness not_run, or without the sanctions search, is refused", () => {
    human(guardian, "1001");
    human(second, "1002");
    const cfg = production();
    recordIdentity(db, cfg, guardian, recordOpts({ result: "needs_review", liveness: "not_run" }));
    recordIdentity(
      db,
      cfg,
      second,
      recordOpts({ result: "needs_review", watchlist: "not_run", nameFirst: "Ana" }),
    );
    const noFace = latestOf(guardian);
    const noSearch = latestOf(second);
    expect(noFace).toMatchObject({ status: "needs_review", environment: "production" });

    expect(
      thrownBy(() =>
        reviewIdentity(
          db,
          cfg,
          "accept",
          guardian,
          decided(noFace.checkId, "provider_flag_cleared"),
        ),
      ),
    ).toBe(NO_FACE_MATCH);
    expect(
      thrownBy(() =>
        reviewIdentity(
          db,
          cfg,
          "accept",
          second,
          decided(noSearch.checkId, "provider_flag_cleared"),
        ),
      ),
    ).toBe(NO_SEARCH);
    // The dry run refuses what the write would.
    expect(
      thrownBy(() =>
        reviewIdentity(db, cfg, "accept", guardian, {
          ...decided(noFace.checkId, "provider_flag_cleared"),
          yes: false,
        }),
      ),
    ).toBe(NO_FACE_MATCH);
    expect(latestOf(guardian).checkId).toBe(noFace.checkId);
    expect(latestOf(second).checkId).toBe(noSearch.checkId);
    // The way out the refusal names.
    reviewIdentity(db, cfg, "refuse", guardian, decided(noFace.checkId, "other"));
    expect(latestOf(guardian).status).toBe("failed");
  });

  test("accept of a name_rule_failed review is refused until identity:correct-name", () => {
    human(guardian, "1001");
    const cfg = production();
    recordIdentity(
      db,
      cfg,
      guardian,
      recordOpts({ nameFirst: "伟", nameLast: "王", watchlist: "hit" }),
    );
    const review = latestOf(guardian);
    expect(review.reviewReasons).toEqual(["watchlist_hit", "name_rule_failed"]);

    const refused = thrownBy(() =>
      reviewIdentity(
        db,
        cfg,
        "accept",
        guardian,
        decided(review.checkId, "watchlist_false_positive"),
      ),
    );
    expect(refused).toBe(
      "refusing: on production a passed check needs a name that passes the name rule (name must be written in the Latin script): correct it with identity:correct-name first",
    );
    expect(latestOf(guardian).checkId).toBe(review.checkId);

    correctIdentityName(db, cfg, guardian, {
      ...decided(review.checkId, "other_script"),
      nameFirst: "Wei",
      nameLast: "WANG",
    });
    const corrected = latestOf(guardian);
    expect(corrected).toMatchObject({ status: "needs_review", reviewReasons: ["watchlist_hit"] });
    reviewIdentity(
      db,
      cfg,
      "accept",
      guardian,
      decided(corrected.checkId, "watchlist_false_positive"),
    );
    expect(latestOf(guardian)).toMatchObject({ status: "passed", environment: "production" });
  });

  test("correct-name onto passed on production with liveness not_run is refused", () => {
    human(guardian, "1001");
    const cfg = production();
    recordIdentity(
      db,
      cfg,
      guardian,
      recordOpts({ result: "needs_review", liveness: "not_run", nameFirst: "伟", nameLast: "王" }),
    );
    const recordedRow = latestOf(guardian);
    expect(recordedRow.reviewReasons).toEqual(["provider_flag", "name_rule_failed"]);
    // A review whose one reason is the name, its face match not run: no command writes it today
    // (such a review carries provider_flag), so it is written straight into the table, as an
    // earlier version could have written it. Its names stay sealed to this tenant.
    const { checkId: _checkId, namesErasedAt: _erased, ...facts } = recordedRow;
    const review = repo.append(
      { ...facts, supersedesCheckId: recordedRow.checkId, reviewReasons: ["name_rule_failed"] },
      {
        kind: "recorded",
        at: Date.now(),
        actor: OPERATOR,
        actorOsUser: null,
        reasonCode: null,
        reason: null,
      },
    );

    expect(
      thrownBy(() =>
        correctIdentityName(db, cfg, guardian, {
          ...decided(review.checkId, "other_script"),
          nameFirst: "Wei",
          nameLast: "Wang",
        }),
      ),
    ).toBe(NO_FACE_MATCH);
    expect(latestOf(guardian).checkId).toBe(review.checkId);
  });

  test("on a sandbox nothing changes: a review without the face match or the search is accepted", async () => {
    human(guardian, "1001");
    const review = await recorded(guardian, {
      "--result": "needs_review",
      "--liveness": "not_run",
      "--watchlist": "not_run",
    });

    await run(decisionLine("identity:accept", guardian, review.checkId, "provider_flag_cleared"));

    expect(latestOf(guardian)).toMatchObject({ status: "passed", environment: "sandbox" });
  });
});

// ── identity:sweep ────────────────────────────────────────────────────────────────────────────

describe("identity:sweep", () => {
  test("sweep erases a superseded row's names after 30 days, never the current verified row, never a needs_review row", async () => {
    human(guardian, "1001");
    human(second, "1002");
    const review = await recorded(guardian, { "--watchlist": "hit" });
    await run(
      decisionLine("identity:accept", guardian, review.checkId, "watchlist_false_positive"),
    );
    const accepted = latestOf(guardian);
    const waiting = await recorded(second, {
      "--watchlist": "hit",
      "--name-first": "Ana",
      "--name-last": "Example",
    });

    // The database writes `created_at` on its own clock; the sweep reads the window from ours.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 31 * DAY });
    const dry = await run<{ erased: boolean; count: number; rules: Record<string, number> }>([
      "identity:sweep",
    ]);
    expect(dry.output).toMatchObject({
      erased: false,
      count: 1,
      rules: { superseded: 1, abandoned: 0, unused: 0 },
    });
    expect(dry.ops).toEqual([]);
    expect(repo.findById(review.checkId)?.names).not.toBeNull();

    const { output, ops } = await run<{ erased: boolean; count: number }>([
      "identity:sweep",
      "--yes",
    ]);

    expect(output).toMatchObject({ erased: true, count: 1 });
    expect(ops).toEqual([
      expect.objectContaining({
        opslog: "identity_names_erased",
        count: 1,
        rules: { superseded: 1, abandoned: 0, unused: 0 },
      }),
    ]);
    expect(repo.findById(review.checkId)).toMatchObject({ names: null });
    expect(repo.events(review.checkId).at(-1)).toMatchObject({
      kind: "names_erased",
      actor: "system",
      reasonCode: "superseded",
    });
    expect(repo.findById(accepted.checkId)?.names).not.toBeNull();
    expect(repo.findById(waiting.checkId)?.names).not.toBeNull();
    expect(showIdentity(db, config(), guardian)).toMatchObject({ state: "verified" });
  });

  test("the exported sweep reads the clock it is handed, as the scheduler hands it, and logs every run", async () => {
    human(guardian, "1001");
    const review = await recorded(guardian, { "--watchlist": "hit" });
    await run(decisionLine("identity:refuse", guardian, review.checkId, "watchlist_confirmed"));

    const from = printed.length;
    expect(sweepIdentityNames(db, config(), { yes: true, nowMs: Date.now() + DAY })).toMatchObject({
      count: 0,
    });
    // A run with --yes says it ran, none erased included.
    expect(
      printed
        .slice(from)
        .filter(isOpsLine)
        .map((line) => JSON.parse(line)),
    ).toEqual([
      expect.objectContaining({
        opslog: "identity_names_erased",
        count: 0,
        rules: { superseded: 0, abandoned: 0, unused: 0 },
      }),
    ]);
    expect(
      sweepIdentityNames(db, config(), { yes: true, nowMs: Date.now() + 31 * DAY }),
    ).toMatchObject({ erased: true, count: 1, rules: { superseded: 1 } });
    expect(repo.findById(review.checkId)?.names).toBeNull();
  });
});

// ── personal data ─────────────────────────────────────────────────────────────────────────────

test("no ops line of any command contains the name", async () => {
  // Nullifiers no timestamp or id could contain, so a match is a leak.
  const nullifiers = ["0x5eed00a1", "0x5eed00b2", "0x5eed00c3"] as const;
  human(guardian, nullifiers[0]);
  human(second, nullifiers[1]);
  human(third, nullifiers[2]);
  // A review accepted, then its name corrected, then revoked.
  const review = await recorded(guardian, { "--watchlist": "hit" });
  await run(decisionLine("identity:accept", guardian, review.checkId, "watchlist_false_positive"));
  await run(
    decisionLine("identity:correct-name", guardian, review.checkId + 1, "transliteration", {
      "--name-first": FIRST,
      "--name-last": "DUPONT-EXAMPLE",
    }),
  );
  await run(decisionLine("identity:revoke", guardian, review.checkId + 2, "fraud"));
  // A duplicate, refused.
  await recorded(third, { "--provider-ref": "vs_test_0003" });
  const duplicate = await recorded(second, { "--provider-ref": "vs_test_0002" });
  await run(decisionLine("identity:refuse", second, duplicate.checkId, "duplicate_identity"));
  await run(["identity:show", guardian]);
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 31 * DAY });
  await run(["identity:sweep", "--yes"]);

  const ops = printed.filter(isOpsLine);
  expect(ops.map((line) => (JSON.parse(line) as { opslog: string }).opslog)).toEqual([
    "identity_recorded",
    "identity_accepted",
    "identity_name_corrected",
    "identity_revoked",
    "identity_recorded",
    "identity_recorded",
    "identity_refused",
    "identity_names_erased",
  ]);
  // Nor any event the commands wrote.
  const events = JSON.stringify(db.prepare("SELECT * FROM identity_check_events").all());
  for (const text of [...ops, events]) {
    expect(text).not.toMatch(SURNAME);
    expect(text).not.toMatch(new RegExp(FIRST));
    for (const nullifier of nullifiers) expect(text).not.toContain(nullifier);
  }
});
