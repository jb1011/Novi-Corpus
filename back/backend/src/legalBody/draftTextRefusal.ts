import type { ApiError } from "../errors";
import { refusal } from "./sentences";
import { type LegalText, LegalTextNotApprovedError, assertTextsServable } from "./texts/index";

/** What a door answers when the legal text it would serve is still a draft on a production
 *  deployment: the one fixed sentence, whichever text it is. */
export function draftTextRefusal(): ApiError {
  return refusal("legal_text_not_approved", 503);
}

/** Passes when `environment` may serve every one of `texts`; else throws the one refusal of a
 *  draft text. */
export function assertDraftsServable(
  environment: "sandbox" | "production",
  texts: readonly LegalText<never>[],
): void {
  try {
    assertTextsServable(environment, texts);
  } catch (err) {
    if (err instanceof LegalTextNotApprovedError) throw draftTextRefusal();
    throw err;
  }
}
