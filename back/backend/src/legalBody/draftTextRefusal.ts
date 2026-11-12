import type { ApiError } from "../errors";
import { refusal } from "./sentences";

/** What a door answers when the legal text it would serve is still a draft on a production
 *  deployment: the one fixed sentence, whichever text it is. */
export function draftTextRefusal(): ApiError {
  return refusal("legal_text_not_approved", 503);
}
