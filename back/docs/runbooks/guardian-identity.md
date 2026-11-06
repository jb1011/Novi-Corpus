# Runbook: the guardian's identity check (slice I-0)

World ID proves one real person; the identity check says who. On a production deployment (Arc
mainnet) a guardian cannot use the legal-body doors until their identity record reads `verified`.
In slice I-0 the provider is **Stripe Identity**, and nothing is automatic: an operator sends the
guardian a link and asks for their legal name, reads the finished session in the Stripe dashboard,
compares the name, and records it from the box with the `identity:*` commands. The doors read what
those commands write.

Every command below runs on the box, from the backend directory:

```bash
npm run cli -- identity:show <tenantId>
```

`<tenantId>` is the guardian's account, their wallet address, in any case: the commands keep it
EIP-55 checksummed and refuse anything that is not an address.

**Never paste a name into a ticket, a chat or a commit.** Not in a `--reason` either: rows and
events are kept for ever. A reason holds ids, codes and facts ("stripe requires_input:
document_unverified_other"), never a person's name, address, email or document number.
`identity:show` is the only command that prints a name, and it writes no ops line.

## 1. The procedure, one guardian

1. **The link.** In the Stripe dashboard, open the guardian-check Verification Flow and copy its
   static link. Append a fresh opaque reference, and nothing else:

   ```
   <flow link>?client_reference_id=<reference>
   ```

   The reference is new for every request (`openssl rand -hex 8` is enough). It is **never** the
   tenant id and never the World ID nullifier: the session lives at Stripe, and neither belongs
   there. Note the reference beside the tenant id wherever you track the request, without the name.

   **Never the person's email address in the link** (no `prefilled_email`): it would sit in the
   email's body and in the provider's URL logs. The guardian types their address in Stripe's flow.
   `email:send-link` refuses a link that carries one.

2. **Send it, and ask for the name.** With `email:send-link` from the box, the address re-read
   from where the guardian gave it (their waitlist entry, their own message), never from a ticket.
   Start the line with a space, so the shell keeps the address out of its history
   (docs/runbooks/email.md):

   ```bash
    npm run cli -- email:send-link <tenantId> \
      --url '<flow link>?client_reference_id=<reference>' --to <the person's address> \
      --operator <your operator name>
   ```

   Without `--yes` it prints the email it would queue (the subject, the key, the link) and writes
   nothing; read it, then run the same line with `--yes`. The email ("Confirm who you are") says
   what is checked, what we keep and what we never keep, gives the link, and asks the guardian to
   reply with their legal name **exactly as printed on the document** they will use: first name,
   last name, and the full name if the document prints more. The address is never printed back.
   One link per guardian per UTC day: a second the same day writes nothing. `email:list --kind
   identity_link` shows whether it was sent and delivered; a bounce is handled as the email
   runbook says (section 5).

   Until PR 2a is deployed, send the same words from the contact mailbox. Send the flow link only:
   it is made to be shared. The dashboard's single-use session links expire after 48 hours and are
   not sent by email, as Stripe advises.

3. **Read the session, and compare the name.** Open the session in the dashboard once the person
   has finished. Each visit to the flow link opens a new session (`vs_…`); record each finished one
   as its own check.

   The name of record is **the guardian's**, as they gave it, confirmed by you against the
   document; it is never a copy of Stripe's output. Why: Stripe's terms limit passing its data on,
   and the name of record reaches the Wyoming filing and the declaration. So read Stripe's verified
   `first_name` and `last_name` and the document image in the session, compare them with the name
   the guardian sent, and record the guardian's version:

   - the same name (case and spacing aside, which the record normalises): record it as the guardian
     gave it;
   - a difference beyond case and spacing (another spelling, a missing or extra name, another
     order): record the guardian's version with `--name-mismatch`. The check lands in review
     (`name_mismatch`). Ask the guardian, then settle it with `identity:correct-name` (section 4)
     to the name the document prints, never silently;
   - no name from the guardian yet: do not record a pass; write to them first.

   What to read:

   | In the session                 | What to type                                                   |
   | ------------------------------ | -------------------------------------------------------------- |
   | status `verified`              | `--result passed`                                              |
   | status `requires_input` + code | `--result failed`, see below                                   |
   | `first_name`, `last_name`      | compare with the guardian's name (above); type the guardian's at the prompt (`--names-prompt`) |
   | `document.type`                | `passport` → `passport`, `id_card` → `identity_card`, `driving_license` → `driving_licence` |
   | `issuing_country` (alpha-2)    | `--country` in alpha-3: FR → FRA, DE → DEU, ES → ESP, GB → GBR, US → USA (ISO 3166-1) |
   | the selfie check `verified`    | `--liveness passed`                                            |

   A `verified` session implies a document in date: Stripe fails an expired document itself, so
   `--document-expired` is for a document you can see is out of date and nothing else. On
   production a pass needs the face match and the sanctions search: `--liveness passed`, and
   `--watchlist clear` or `hit` (never `not_run`).

   A name printed in capitals (`DUPONT`) is stored as a person writes it (`Dupont`); a mixed-case
   name is stored as typed.

4. **Search the sanctions lists by hand.** Search the full name on OpenSanctions and note the
   result: `--watchlist clear`, or `--watchlist hit` for a possible match (the check then waits
   for your decision, section 3).

5. **Record it.** Take `--expect-latest` from `identity:show` (`expectLatest`: a check id, or
   `none` for a guardian with no check yet), then:

   ```bash
   npm run cli -- identity:show <tenantId>
   npm run cli -- identity:record <tenantId> \
     --provider stripe --provider-ref vs_… --result passed --names-prompt \
     --country FRA --document-type passport --liveness passed --watchlist clear \
     --completed-at '<the session's completion time, ISO-8601 with its zone>' \
     --operator <your operator name> --expect-latest none
   ```

   `--names-prompt` asks for the first name, the last name and the full name (optional: Enter skips
   it), so no name is on the command line, in the shell history or in the process list. Add
   `--name-mismatch` when the guardian's name differs from the document's (step 3).

   Without `--yes` the command prints what it would write and writes nothing; read it, then run the
   same line with `--yes` (the prompt asks for the names again). `--completed-at` defaults to now; a
   time in the future is refused, and so is one so old that the pass would already be expired. The
   check is valid for `IDENTITY_REVERIFY_YEARS` (three) calendar years from its completion.

   A failed session:

   ```bash
   npm run cli -- identity:record <tenantId> \
     --provider stripe --provider-ref vs_… --result failed \
     --reason-code selfie_mismatch --reason 'stripe requires_input: selfie_face_mismatch' \
     --operator <your operator name> --expect-latest <id> --yes
   ```

   A failed check keeps no name: the name flags are refused with it. Its `--reason-code` comes
   from its own list, Stripe's error code going in the reason:

   | Stripe's `last_error.code`                                                    | `--reason-code`       |
   | ----------------------------------------------------------------------------- | --------------------- |
   | `document_unverified_other`, `document_type_not_supported`                    | `document_unverified` |
   | `document_expired`                                                            | `document_expired`    |
   | `selfie_face_mismatch`, `selfie_document_missing_photo`, `selfie_manipulated`, `selfie_unverified_other` | `selfie_mismatch` |
   | `consent_declined`                                                            | `consent_declined`    |
   | `abandoned`, or a session the person never finished                           | `abandoned`           |
   | anything else                                                                 | `other`               |

6. **Check it.** `identity:show <tenantId>` reads `verified`, or `needs_review` with its reasons.

   When `identity:show` reads `verified` but `countsAtTheDoors` is `false`, another person has
   verified World ID on the account since the record was written: the record belongs to the
   earlier person, and every production door refuses it. The new person needs their own check,
   by this procedure from step 1.

7. **Redact the session** from the Stripe dashboard once the record is written, within the week.
   Our record is then the only trace of the check.

### Renewal, and a change of name

A guardian verifies again before the check expires (`expiresAt`, three years), or after a change of
name, by the same procedure: a new link, the guardian's name asked for again and compared with the
document as in step 3, a new session, and `identity:record --result passed --names-prompt` with
`--expect-latest` the current check's id. The new check supersedes the current one and names it
(`supersedesCheckId`): the guardian stays `verified`, and the expiry counts from the new completion,
which must be after the current pass's (an older one is refused, so an expiry never moves back).
Every rule of a pass applies, the duplicate check, `--name-mismatch` and the production rules
included, so a renewal that lands in review (a watchlist hit, a duplicate, a name that differs)
puts the guardian in review until you decide it. A failed session over a verified guardian is not
recorded as such: revoke first if the guardian must lose the pass.

### What `identity:record` refuses

- No World ID verification for the guardian action. On production the verification must be a real
  human's (an accepted credential, made under World's production environment): a waiver is
  refused (`the account has no production World ID verification`). The record copies its nullifier.
- `--expect-latest` that is not the tenant's latest check: another operator wrote since, or the line
  came from the shell history. Run `identity:show` and decide again.
- On a guardian who is `verified` already, `--result failed` or `--result needs_review`: a renewal
  records `--result passed` (above). Correct a name with `identity:correct-name`, or revoke first
  (`identity:revoke`) when a failed check or a review must be recorded.
- A pass over a pass whose `--completed-at` is not after the current pass's completion (`a renewal
  must complete after the current pass`), and any pass whose `--completed-at` is so old that it
  would already be expired.
- `--names-prompt` with `--name-first`, `--name-last` or `--name-full`, or with `--result failed`;
  `--name-mismatch` with `--result failed`.
- `FORMATION_PII_KEY` missing: the names are encrypted under it. `identity:show`, `identity:accept`
  and `identity:correct-name` refuse for the same reason. With the PII key set, the box does not
  boot without `IDENTITY_NAME_HMAC_KEY` (section 6).
- On production, `--result passed` without `--liveness passed`, or with `--watchlist not_run`.
- `--provider sandbox` on production.
- `--operator system`: the sweep writes its erasures under that name, and every command refuses it.

## 2. Why a passed session lands in review

A passed result is stored as `needs_review`, never `passed`, when any of these holds. Each is a
review reason on the row:

| Review reason        | What it means                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `provider_flag`      | You recorded `--result needs_review`: something in the session needs a second look.              |
| `watchlist_hit`      | Your sanctions search found a possible match.                                                     |
| `document_expired`   | You flagged the document as out of date.                                                          |
| `country_blocked`    | The document's country is in `SCREENING_BLOCKED_COUNTRIES` (default CUB, IRN, PRK).               |
| `name_rule_failed`   | The name breaks the name rule: a first or last name missing, a character the declaration refuses, or a script other than Latin. A person with a single legal name lands here too: never invent a name or use a placeholder; write to Martin, and the case waits for counsel's answer on how a single-name person is named in a Wyoming filing. |
| `name_mismatch`      | You recorded `--name-mismatch`: the guardian's name differs from the document's beyond case and spacing. Ask the guardian, then `identity:correct-name` (section 4). |
| `duplicate_identity` | Another guardian's current passed check holds the same name and document country. The output lists those check ids (`duplicateOf`), never the name. |

To see who holds a duplicate, read the tenant of each listed check, then show it:

```bash
sqlite3 -readonly -cmd ".timeout 5000" "$DATA_DIR/legalbody.db" \
  "SELECT check_id, tenant_id, status FROM guardian_identity_checks WHERE check_id IN (<ids>);"
npm run cli -- identity:show <that tenantId>
```

## 3. Deciding a review

Every decision takes `--operator`, `--expect-latest <the review's check id>`, a `--reason-code`
from its closed list, a `--reason`, and `--yes`. Each appends a new row; nothing is ever changed or
deleted.

- `identity:accept <tenantId>`: the review was fine. A passed row with the review's facts and its
  names (sealed again under the current PII key; the name's fingerprint, computed again, is the
  same, since that key takes no part in it). It refuses a review with `name_mismatch`, on every
  environment: that one is settled with `identity:correct-name` (section 4), after asking the
  guardian. It is refused while another account's current passed check holds the same name and
  document country, however the review began: the refusal lists those checks. Refuse this one
  with `duplicate_identity`, or revoke the other first.
- `identity:refuse <tenantId>`: it was not. A failed row without names. Also for an attempt that
  never completed.

On production a passed row needs the face match, the sanctions search and a name that passes the
name rule, however it is written: `identity:accept` refuses a review recorded with `--liveness`
other than `passed` or with `--watchlist not_run` (refuse it and record a new check), and a review
whose name breaks the rule (correct it first with `identity:correct-name`). `identity:correct-name`
refuses to land a check `passed` without the face match and the search in the same way.

Each decision takes only its own codes, `other` in both:

| `identity:accept`          | Use it when                                                              |
| -------------------------- | ------------------------------------------------------------------------ |
| `provider_flag_cleared`    | your second look found nothing wrong.                                    |
| `watchlist_false_positive` | the possible match is someone else (another birth date, another country). |
| `other`                    | anything else; say what in the reason, without a name.                  |

| `identity:refuse`          | Use it when                                                              |
| -------------------------- | ------------------------------------------------------------------------ |
| `watchlist_confirmed`      | the match is the guardian.                                               |
| `country_blocked`          | the document's country is blocked.                                       |
| `document_expired`         | the document is out of date.                                             |
| `duplicate_identity`       | the person already holds a verified record under another account.        |
| `name_rule_failed`         | no usable name of record (prefer `identity:correct-name` when the document shows one). |
| `other`                    | anything else; say what in the reason, without a name.                  |

`identity:revoke <tenantId>` revokes a passed check (`fraud`, `watchlist_confirmed`, `court_order`,
`duplicate_identity`, `other`): a revoked row without names. It is the identity side only: a live
company is revoked with `company:revoke`, by its own decision.

## 4. When a name looks wrong

```bash
npm run cli -- identity:correct-name <tenantId> --names-prompt \
  --reason-code <code> --reason '<why, without a name>' \
  --operator <your operator name> --expect-latest <the check's id> --yes
```

writes the name of record again, for a passed check or a review; the prompt asks for the first, the
last and the optional full name. The new name must pass the name rule. Without a full name the
record keeps none: the old one is never carried over a correction. The corrected name settles
`name_rule_failed` and `name_mismatch`: the row passes when the review had no other reason, and it
lands in review again when the new name matches another guardian's current passed check
(`duplicate_identity`).

For a `name_mismatch`, ask the guardian first, then record the name the document prints, the
guardian having confirmed it. Never settle a difference without the guardian's answer.

Before correcting, search the corrected name on OpenSanctions, as for a new check: the search was
made on the old name. On a hit, do not correct: refuse the review (`watchlist_confirmed` once you
have confirmed it), or revoke a passed check.

Then compare:

- the name the guardian gave, the name Stripe extracted, and the name printed on the document image
  in the session;
- for a passport, the Latin form in the machine-readable zone (the two lines at the bottom of the
  photo page): it is the form a document in another script gives in Latin, and the form to record;
- the order of the names: the family name is the last name (the second prompt), whatever order the
  document prints.

Never change a name to what the person asks for unless the document shows it. Codes:
`transliteration` (a Latin spelling of the same name), `other_script` (the document's name is in
another script; record its Latin form), `name_change` (a new document with a new name), `rule_failed`
(the name broke the rule for another reason), `other`.

A check whose names were erased (section 5) cannot be corrected: record a new check.

## 5. Retention: the daily sweep

The names of a check are erased, the rest of the row kept, when:

- it is superseded (a newer check of the same guardian exists), or an attempt never completed,
  after `IDENTITY_FAILED_RETENTION_DAYS` (default 30);
- it is a passed check of a guardian with **no live company**, after
  `IDENTITY_UNUSED_RETENTION_DAYS` (default 365). That guardian then reads `expired` and verifies
  again before using a door, even inside the three years.

A guardian with a live company keeps the names on every row, and a review is never erased: it
waits for your decision.

The scheduler runs the sweep daily inside the API (`job_ran` in the ops log, `name: identity_sweep`).
To see what is due, `npm run cli -- identity:sweep` (it erases nothing without `--yes`). For a manual
run, `npm run cli -- scheduler:run identity_sweep --yes`. Each erasure is a `names_erased` event by
`system`. Every run with `--yes`, none erased included, writes one ops line,
`identity_names_erased { count, rules }`, which holds no name.

## 6. The two keys: the PII key may rotate, the fingerprint key never does

Two settings hold the record's secrets, both on any box with the PII key:

- `FORMATION_PII_KEY` seals the names (AES-256-GCM); each row names the key it was sealed under.
- `IDENTITY_NAME_HMAC_KEY` (32 bytes as 64 hex characters, `openssl rand -hex 32`) keys the name's
  fingerprint, the digest the duplicate check compares. The box refuses to boot with the PII key
  and without it. Back it up beside the PII key.

**`IDENTITY_NAME_HMAC_KEY` never rotates.** A name has one fingerprint for the life of the record,
so the duplicate check finds a pass whatever key its names are sealed under. If it is ever
compromised, the fix is a one-off migration that computes every row's fingerprint again under a new
secret from the decrypted names; it is written when it is needed, not before.

**`FORMATION_PII_KEY` may rotate.** A rotation moves the old key to `FORMATION_PII_KEY_PREVIOUS`
and sets a new `FORMATION_PII_KEY`: new rows are sealed under the new key, older rows still open
under the previous one. The fingerprints do not change. Only the current and the previous key are
supported, and there is no command that seals the older rows again. So `FORMATION_PII_KEY_PREVIOUS`
stays configured until every row sealed under it that still holds names and may still be read is
gone:

- a passed row, until it is superseded or expired (up to three years, `IDENTITY_REVERIFY_YEARS`);
- a `needs_review` row, until it is decided (`identity:accept` reads its names);
- any latest row an operator may need to show (`identity:show`).

A second rotation inside that window leaves those rows unreadable. The SSN side has its own,
shorter window (docs/runbooks/doola-deploy.md, A2); keep the previous key until both are clear.

A CRITICAL `identity_names_unreadable { checkId, keyId, tenant }` in the ops log means a row's key
is missing on this deployment: that guardian's `GET /world-id/me` and the declared doors answer 503
`identity_unavailable` until the key named by `keyId` is configured again. The line holds ids only.
`identity:show` on such a row prints `names: null`, the row's `nameKeyId` and a one-line note,
and the rest of the record as usual.

## 7. Disclosure

A lawful request for the evidence file of a check is answered that none exists: the Stripe session
is redacted once our record is written, and we hold no document, no photo, no date of birth and no
document number. What we hold is the record itself: the result, the dates, the document's country
and type, and the names of record, encrypted.
