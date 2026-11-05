# Runbook: the guardian's identity check (slice I-0)

World ID proves one real person; the identity check says who. On a production deployment (Arc
mainnet) a guardian cannot use the legal-body doors until their identity record reads `verified`.
In slice I-0 the provider is **Stripe Identity**, and nothing is automatic: an operator sends the
guardian a link, reads the finished session in the Stripe dashboard, and records it from the box
with the `identity:*` commands. The doors read what those commands write.

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
   static link. Append a fresh opaque reference and the person's email address:

   ```
   <flow link>?client_reference_id=<reference>&prefilled_email=<the person's address>
   ```

   The reference is new for every request (`openssl rand -hex 8` is enough). It is **never** the
   tenant id and never the World ID nullifier: the session lives at Stripe, and neither belongs
   there. Note the reference beside the tenant id wherever you track the request, without the name.

2. **Send it.** With `email:send-link` from the box (PR 2a), or, until PR 2a is deployed, from the
   contact mailbox. Send the flow link only: it is made to be shared. The dashboard's single-use
   session links expire after 48 hours and are not sent by email, as Stripe advises.

3. **Read the session** in the dashboard once the person has finished. Each visit to the flow link
   opens a new session (`vs_…`); record each finished one as its own check. What to read:

   | In the session                 | What to type                                                   |
   | ------------------------------ | -------------------------------------------------------------- |
   | status `verified`              | `--result passed`                                              |
   | status `requires_input` + code | `--result failed`, see below                                   |
   | `first_name`, `last_name`      | `--name-first`, `--name-last`, as shown                        |
   | `document.type`                | `passport` → `passport`, `id_card` → `identity_card`, `driving_license` → `driving_licence` |
   | `issuing_country` (alpha-2)    | `--country` in alpha-3: FR → FRA, DE → DEU, ES → ESP, GB → GBR, US → USA (ISO 3166-1) |
   | the selfie check `verified`    | `--liveness passed`                                            |

   A `verified` session implies a document in date: Stripe fails an expired document itself, so
   `--document-expired` is for a document you can see is out of date and nothing else.

   A name printed in capitals (`DUPONT`) is stored as a person writes it (`Dupont`); a mixed-case
   name is stored as typed. Type it as the session shows it.

4. **Search the sanctions lists by hand.** Search the full name on OpenSanctions and note the
   result: `--watchlist clear`, or `--watchlist hit` for a possible match (the check then waits
   for your decision, section 3).

5. **Record it.** Take `--expect-latest` from `identity:show` (`expectLatest`: a check id, or
   `none` for a guardian with no check yet), then:

   ```bash
   npm run cli -- identity:show <tenantId>
   npm run cli -- identity:record <tenantId> \
     --provider stripe --provider-ref vs_… --result passed \
     --name-first '<first name>' --name-last '<last name>' \
     --country FRA --document-type passport --liveness passed --watchlist clear \
     --completed-at '<the session's completion time, ISO-8601 with its zone>' \
     --operator <your operator name> --expect-latest none
   ```

   Without `--yes` the command prints what it would write and writes nothing; read it, then run the
   same line with `--yes`. `--completed-at` defaults to now; a time in the future is refused. The
   check is valid for `IDENTITY_REVERIFY_YEARS` (three) calendar years from its completion.

   Type the line yourself, in the box's shell. Do not keep it in a file, and clear it from the shell
   history afterwards (`history -d <n>`): it holds the name.

   A failed session:

   ```bash
   npm run cli -- identity:record <tenantId> \
     --provider stripe --provider-ref vs_… --result failed \
     --reason-code other --reason 'stripe requires_input: selfie_face_mismatch' \
     --operator <your operator name> --expect-latest <id> --yes
   ```

   A failed check keeps no name: the name flags are refused with it. Use `--reason-code
   document_expired` for Stripe's `document_expired`, and `other` with Stripe's code in the reason
   for anything else.

6. **Check it.** `identity:show <tenantId>` reads `verified`, or `needs_review` with its reasons.

7. **Redact the session** from the Stripe dashboard once the record is written, within the week.
   Our record is then the only trace of the check.

### What `identity:record` refuses

- No World ID verification for the guardian action. On production the verification must be a real
  human's (an accepted credential, made under World's production environment): a waiver is
  refused (`the account has no production World ID verification`). The record copies its nullifier.
- `--expect-latest` that is not the tenant's latest check: another operator wrote since, or the line
  came from the shell history. Run `identity:show` and decide again.
- A guardian who is `verified` already: correct a name with `identity:correct-name`, or revoke
  first (`identity:revoke`) when a new check is really needed.
- `FORMATION_PII_KEY` missing: the names are encrypted under it. `identity:show`, `identity:accept`
  and `identity:correct-name` refuse for the same reason.
- `--provider sandbox` on production.

## 2. Why a passed session lands in review

A passed result is stored as `needs_review`, never `passed`, when any of these holds. Each is a
review reason on the row:

| Review reason        | What it means                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `provider_flag`      | You recorded `--result needs_review`: something in the session needs a second look.              |
| `watchlist_hit`      | Your sanctions search found a possible match.                                                     |
| `document_expired`   | You flagged the document as out of date.                                                          |
| `country_blocked`    | The document's country is in `SCREENING_BLOCKED_COUNTRIES` (default CUB, IRN, PRK).               |
| `name_rule_failed`   | The name breaks the name rule: a first or last name missing, a character the declaration refuses, or a script other than Latin. |
| `duplicate_identity` | Another guardian's current passed check holds the same name and document country. The output lists those check ids (`duplicateOf`), never the name. |

To see who holds a duplicate, read the tenant of each listed check, then show it:

```bash
sqlite3 "$DATA_DIR/legalbody.db" \
  "SELECT check_id, tenant_id, status FROM guardian_identity_checks WHERE check_id IN (<ids>);"
npm run cli -- identity:show <that tenantId>
```

## 3. Deciding a review

Every decision takes `--operator`, `--expect-latest <the review's check id>`, a `--reason-code`
from its closed list, a `--reason`, and `--yes`. Each appends a new row; nothing is ever changed or
deleted.

- `identity:accept <tenantId>`: the review was fine. A passed row with the review's facts and its
  names (sealed again under the current key, the name digest computed again under it).
- `identity:refuse <tenantId>`: it was not. A failed row without names. Also for an attempt that
  never completed.

| Decision code              | Use it when                                                              |
| -------------------------- | ------------------------------------------------------------------------ |
| `provider_flag_cleared`    | accept: your second look found nothing wrong.                            |
| `watchlist_false_positive` | accept: the possible match is someone else (another birth date, another country). |
| `watchlist_confirmed`      | refuse: the match is the guardian.                                       |
| `country_blocked`          | refuse: the document's country is blocked.                               |
| `document_expired`         | refuse: the document is out of date.                                     |
| `duplicate_identity`       | refuse: the person already holds a verified record under another account. |
| `name_rule_failed`         | refuse: no usable name of record (prefer `identity:correct-name` when the document shows one). |
| `other`                    | anything else; say what in the reason, without a name.                  |

`identity:revoke <tenantId>` revokes a passed check (`fraud`, `watchlist_confirmed`, `court_order`,
`duplicate_identity`, `other`): a revoked row without names. It is the identity side only: a live
company is revoked with `company:revoke`, by its own decision.

## 4. When a name looks wrong

`identity:correct-name <tenantId> --name-first … --name-last … [--name-full …]` writes the name of
record again, for a passed check or a review. The new name must pass the name rule. The row passes
when the review had no reason other than `name_rule_failed`, and it lands in review again when the
new name matches another guardian's current passed check (`duplicate_identity`).

Before correcting, compare:

- the name Stripe extracted with the name printed on the document image in the session;
- for a passport, the Latin form in the machine-readable zone (the two lines at the bottom of the
  photo page): it is the form a document in another script gives in Latin, and the form to record;
- the order of the names: the family name goes in `--name-last`, whatever order the document prints.

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

A guardian with a live company keeps every row, and a review is never erased: it waits for your
decision.

The scheduler runs the sweep daily inside the API (`job_ran` in the ops log, `name: identity_sweep`).
To see what is due, `npm run cli -- identity:sweep` (it erases nothing without `--yes`). For a manual
run, `npm run cli -- scheduler:run identity_sweep --yes`. Each erasure is a `names_erased` event by
`system`, and one ops line, `identity_names_erased { count, rules }`, holds no name.

## 6. Disclosure

A lawful request for the evidence file of a check is answered that none exists: the Stripe session
is redacted once our record is written, and we hold no document, no photo, no date of birth and no
document number. What we hold is the record itself: the result, the dates, the document's country
and type, and the names of record, encrypted.
