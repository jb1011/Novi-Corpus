import type Database from "better-sqlite3";
import { StripeIdentityClient } from "../adapters/stripe/identityClient";
import type { StripeIdentityWebhookDeps } from "../api/routes/stripeIdentityWebhook";
import type { WorldIdDeps } from "../api/routes/worldId";
import { type Config, legalBodyEnvironment } from "../config/env";
import { SqliteIdentityRepository } from "../persistence/identityRepository";
import { SqliteIdentitySessionRepository } from "../persistence/identitySessionRepository";
import { OpenSanctionsPersonScreener } from "../screening/personScreener";
import type { TaskTracker } from "../util/taskTracker";
import type { IdentitySessionDeps } from "./sessions";
import type { IdentityDeps } from "./state";

/**
 * THE IDENTITY CHECK'S WIRING: what the API process builds from its config for the guardian
 * identity record, the automatic identity check and its webhook. `main.ts` hands `identity`,
 * `identityCheck` and `stripeIdentity` to `buildApiApp`, and `identityCheck` to
 * `buildScheduledJobs`; built here, once, so the rules that bind them hold by construction:
 *
 * - The record is built wherever the PII key is set (the names of record are sealed under it),
 *   and it is ONE object: the check's `identity` is the record itself, so a check it completes is
 *   the one `/world-id/me` and the gate read. It is `automatic` exactly where the Stripe block is
 *   set.
 * - The check and its webhook are built only where the Stripe block is set, both on this
 *   deployment's environment (`legalBodyEnvironment`): the app's build refuses two that differ.
 * - The screener is built only with the OpenSanctions key; the boot rule requires the key on a
 *   production deployment with the Stripe block, so only a sandbox goes without.
 * - The record and the sessions table are read through `db`, the API process's one connection:
 *   the service's transactions span both.
 *
 * Nothing here reveals a secret: the provider client and the screener hold the config's
 * wrappers, and the webhook is handed them as they are.
 */

/** The guardian identity record as this process builds it: the name fingerprint's key rides on
 *  it, for the session service. */
export type IdentityRecordDeps = IdentityDeps & { nameHmacKey: Buffer };

export interface IdentityWiring {
  /** `ApiDeps.identity`: where the PII key is set. */
  identity: IdentityRecordDeps | undefined;
  /** `ApiDeps.identityCheck` and the scheduler's `identitySessions`: where the Stripe block is
   *  set. Its `identity` is `identity` above, the same object. */
  identityCheck: IdentitySessionDeps | undefined;
  /** `ApiDeps.stripeIdentity`: the webhook's secrets, on the identity check's environment. */
  stripeIdentity: StripeIdentityWebhookDeps | undefined;
}

type WiringConfig = Pick<
  Config,
  "pii" | "identity" | "stripeIdentity" | "screening" | "webOrigin" | "arcNetwork"
>;

/**
 * Build the identity record, the identity check and its webhook's deps from `cfg`, over `db`.
 * `world` is the World deps the process already built (or none); `tasks` is the tracker the
 * webhook's reads run on, which the process drains on SIGTERM.
 */
export function identityWiringOf(
  cfg: WiringConfig,
  db: Database.Database,
  world: WorldIdDeps | undefined,
  tasks: TaskTracker,
): IdentityWiring {
  const stripe = cfg.stripeIdentity;
  if (!cfg.pii) {
    // `loadConfig` refuses the Stripe block without the PII key; said again here, since a check
    // with no record would complete nothing.
    if (stripe) throw new Error("identity wiring: the Stripe Identity block needs the PII key");
    return { identity: undefined, identityCheck: undefined, stripeIdentity: undefined };
  }
  // `loadConfig` refuses the PII key without the fingerprint's key.
  const nameHmacKey = cfg.identity.nameHmacKey;
  if (!nameHmacKey)
    throw new Error("identity wiring: the PII key is set but IDENTITY_NAME_HMAC_KEY is not");

  const identity: IdentityRecordDeps = {
    repo: new SqliteIdentityRepository(db),
    pii: cfg.pii,
    reverifyYears: cfg.identity.reverifyYears,
    blockedCountries: cfg.identity.blockedCountries,
    nameHmacKey,
    automatic: stripe !== undefined,
  };
  if (!stripe) return { identity, identityCheck: undefined, stripeIdentity: undefined };

  // One value for both blocks.
  const environment = legalBodyEnvironment(cfg);
  const openSanctions = cfg.screening?.openSanctions;
  const identityCheck: IdentitySessionDeps = {
    identity,
    world,
    sessions: new SqliteIdentitySessionRepository(db),
    provider: new StripeIdentityClient({ key: stripe.key }),
    screener: openSanctions
      ? new OpenSanctionsPersonScreener({
          apiKey: openSanctions.apiKey,
          dataset: openSanctions.dataset,
          threshold: openSanctions.threshold,
        })
      : undefined,
    environment,
    flowId: stripe.flowId,
    webOrigin: cfg.webOrigin,
    limits: {
      sessionDays: cfg.identity.sessionDays,
      maxPerDay: cfg.identity.sessionMaxPerDay,
      attemptsPerSession: cfg.identity.attemptsPerSession,
      redactAfterDays: cfg.identity.redactAfterDays,
    },
    tasks,
  };
  const stripeIdentity: StripeIdentityWebhookDeps = {
    webhookSecret: stripe.webhookSecret,
    webhookSecretPrevious: stripe.webhookSecretPrevious,
    environment,
  };
  return { identity, identityCheck, stripeIdentity };
}

/**
 * The boot line, where the Stripe block is set: the provider's mode, and whether the check is
 * offered (a sandbox, where the gate stays skipped) or required (production). Never the key, the
 * flow id or a secret.
 */
export function identityCheckBootLine(
  cfg: Pick<Config, "stripeIdentity" | "arcNetwork">,
): string | undefined {
  if (!cfg.stripeIdentity) return undefined;
  const need = legalBodyEnvironment(cfg) === "production" ? "required" : "offered";
  return `⚠ identity check: automatic (stripe, ${cfg.stripeIdentity.mode}), ${need}`;
}
