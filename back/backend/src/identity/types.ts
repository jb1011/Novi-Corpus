/**
 * The vocabulary of the guardian's identity record (identity design 6.3; the rows themselves are
 * in `persistence/identityRepository.ts`): the status a row is written with, the state a tenant's
 * rows add up to, and the closed lists of codes a row or an operator's decision carries.
 *
 * World ID proves one real person; the identity check says who.
 */

/** The status a row is written with. A tenant's state is derived from its latest row. */
export type IdentityRowStatus = "started" | "passed" | "failed" | "needs_review" | "revoked";
/** What a tenant's rows add up to: derived from them, never stored. */
export type IdentityState =
  | "none"
  | "pending"
  | "needs_review"
  | "failed"
  | "verified"
  | "expired"
  | "revoked";
export type IdentityProvider = "stripe" | "persona" | "sumsub" | "sandbox";
export type DocumentType = "passport" | "identity_card" | "driving_licence";
export type Watchlist = "clear" | "hit" | "not_run";
export type Liveness = "passed" | "failed" | "not_run";
/** Why a check went to review rather than passing. `name_mismatch`: the name the guardian gave
 *  differs from the document's beyond the case and spacing `nameOfRecord` normalises. */
export type ReviewReasonCode =
  | "provider_flag"
  | "watchlist_hit"
  | "country_blocked"
  | "document_expired"
  | "duplicate_identity"
  | "name_rule_failed"
  | "name_mismatch";
/** What the operator found when deciding a review, to accept or to refuse it. */
export type ReviewDecisionCode =
  | "provider_flag_cleared"
  | "watchlist_false_positive"
  | "watchlist_confirmed"
  | "country_blocked"
  | "document_expired"
  | "duplicate_identity"
  | "name_rule_failed"
  | "other";
/** Why a check the provider did not pass failed, as the operator records it. */
export type FailureReasonCode =
  | "document_unverified"
  | "document_expired"
  | "selfie_mismatch"
  | "consent_declined"
  | "abandoned"
  | "other";
/** Why a passed record was revoked. */
export type RevokeReasonCode =
  | "fraud"
  | "watchlist_confirmed"
  | "court_order"
  | "duplicate_identity"
  | "other";
/** Why the name of record was corrected. */
export type NameCorrectionCode =
  | "transliteration"
  | "other_script"
  | "name_change"
  | "rule_failed"
  | "other";

// The closed lists, each entry checked against its type, the two written side by side.
// `REVIEW_REASON_CODES` is the repository's shape check on a row's review reasons; the others are
// the `--reason-code` values the operator commands take, and list in their --help. An acceptance
// and a refusal each take their own part of the decision codes, `other` in both.
export const REVIEW_REASON_CODES: readonly string[] = [
  "provider_flag",
  "watchlist_hit",
  "country_blocked",
  "document_expired",
  "duplicate_identity",
  "name_rule_failed",
  "name_mismatch",
] satisfies readonly ReviewReasonCode[];
/** The review reasons that end the pass a renewal renews (decided 6 November): a sanctions hit and
 *  a blocked country. A review for any other reason leaves the earlier pass counting
 *  (`identity/state.ts`). */
export const PASS_ENDING_REVIEW_REASONS: readonly ReviewReasonCode[] = [
  "watchlist_hit",
  "country_blocked",
];
/**
 * The events an operator's decision writes its row with (`identity:accept`, `identity:refuse`,
 * `identity:revoke`, `identity:correct-name`). A row written with any other event is an attempt:
 * the adapter's `started` row and its session's completion, or an operator's `identity:record`,
 * all `recorded`. A decision written since a pass ends it (the renewal rule, `identity/state.ts`,
 * and its SQL mirror `COUNTED_BY_RENEWAL` in `persistence/identityRepository.ts`).
 */
export const DECISION_EVENT_KINDS: readonly string[] = [
  "accepted",
  "refused",
  "revoked",
  "name_corrected",
];
/** The decision codes of an acceptance: what the operator found that clears the review. */
export const ACCEPT_DECISION_CODES: readonly string[] = [
  "provider_flag_cleared",
  "watchlist_false_positive",
  "other",
] satisfies readonly ReviewDecisionCode[];
/** The decision codes of a refusal: what the operator found that fails the check. */
export const REFUSE_DECISION_CODES: readonly string[] = [
  "watchlist_confirmed",
  "country_blocked",
  "document_expired",
  "duplicate_identity",
  "name_rule_failed",
  "other",
] satisfies readonly ReviewDecisionCode[];
export const FAILURE_REASON_CODES: readonly string[] = [
  "document_unverified",
  "document_expired",
  "selfie_mismatch",
  "consent_declined",
  "abandoned",
  "other",
] satisfies readonly FailureReasonCode[];
export const REVOKE_REASON_CODES: readonly string[] = [
  "fraud",
  "watchlist_confirmed",
  "court_order",
  "duplicate_identity",
  "other",
] satisfies readonly RevokeReasonCode[];
export const NAME_CORRECTION_CODES: readonly string[] = [
  "transliteration",
  "other_script",
  "name_change",
  "rule_failed",
  "other",
] satisfies readonly NameCorrectionCode[];
