# Runbook: the guardian's identity check (slices I-0 and I-A)

World ID proves one real person; the identity check says who. On a production deployment (Arc
mainnet) a guardian cannot use the legal-body doors until their identity record reads `verified`.
The provider is **Stripe Identity**, and two paths write the record:

- **the automatic check** (section 0, slice I-A), on a box that holds the Stripe Identity block: the
  guardian types their name, verifies on Stripe's page, and the server reads the result back with
  its own key, screens the person against the sanctions lists and writes the record itself;
- **the operator path** (section 1, slice I-0), on a box without the block, and as the fallback
  everywhere: an operator sends the guardian a link and asks for their legal name, reads the
  finished session in the Stripe dashboard, compares the name, and records it from the box with the
  `identity:*` commands.

The doors read the same record, whichever path wrote it.

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

## 0. The automatic check

Where the three `STRIPE_IDENTITY_*` settings are set, the API runs the check itself. On production
it is **required**: the gate refuses a guardian whose record is not `verified`. On a sandbox it is
**offered**: the guardian may run it, and the gate stays skipped. The API says which at boot, in one
line of its log (`⚠ identity check: automatic (stripe, test|live), offered|required`):

```
⚠ identity check: automatic (stripe, test), offered      # a testnet box
⚠ identity check: automatic (stripe, live), required     # a mainnet box
```

The boot rules refuse the other two pairs. No such line: the block is not set, the check is the
operator's (section 1), and the three `/identity-check` routes answer 404
`identity_check_not_offered`.

How one check runs:

1. The guardian types their first and last name as the document prints them, and starts the check
   (`POST /identity-check/sessions`). The API writes a `started` row by `system`, opens a session at
   Stripe under our own session id (Stripe's `client_reference_id`, never the tenant id), and seals
   the typed names in the session row.
2. The person verifies on Stripe's page. Its link lasts 48 hours; starting again answers a fresh
   link to the same session. One session takes `IDENTITY_ATTEMPTS_PER_SESSION` attempts (three).
3. A read follows each change: woken by Stripe's webhook, by the guardian's return to the site
   (`POST /identity-check/sync`), or made by the job `identity_sessions_sync`. The webhook carries
   no fact: every fact comes from the read, made over TLS with our key.
4. A verified session: the sanctions and PEP search on the typed name and the birth date (where
   `OPENSANCTIONS_API_KEY` is set), then the row, `passed` or `needs_review` (0.5). A failed one:
   after the last attempt, or a code no retry changes (`consent_declined`, `under_supported_age`,
   `country_not_supported`), a `failed` row. A session nobody finishes closes as `abandoned` after
   `IDENTITY_SESSION_DAYS` (14). The close erases the typed names.
5. `IDENTITY_REDACT_AFTER_DAYS` (seven) days after the row, or after the operator's decision when
   the row went to review (or once anything is written over the review), the job asks Stripe to
   redact the session.

The rows carry `operator: null` and their events the actor `system`. The name of record is the
guardian's typed name, confirmed against the document's; Stripe's extracted names are compared and
dropped (the testnet does not compare them, 0.2).

An operator's row written while a session is open stands: the session then closes without a row
of its own, and the job never writes over it (0.4).

### 0.1 Setting it up, per box

Set the block only on a box whose backend answers `held` in `GET /identity-check/session`: the
site's card needs it (0.7). On an older backend the card says "being read" for a session that waits
for the search or for an operator, and its reads of a session that waits for the search run the
search again.

In the Stripe dashboard, in the mode of the box (the founder who holds the account does it):

|                         | testnet box                                           | mainnet box                                              |
| ----------------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| Stripe mode             | test mode (0.2)                                       | live mode                                                |
| `ARC_NETWORK`           | `testnet` (or unset)                                  | `mainnet`                                                |
| the key                 | `rk_test_…`                                           | `rk_live_…`                                              |
| the webhook endpoint    | `https://<api host>/webhooks/stripe-identity/sandbox` | `https://<api host>/webhooks/stripe-identity/production` |
| `OPENSANCTIONS_API_KEY` | optional: without it no search runs (`watchlist: not_run`) | required                                            |

1. **A restricted key**, named `novi-identity-<box>`, with two permissions and nothing else:
   "Identity verification sessions and reports: Write" and "Recent detailed verification results:
   Read". If the dashboard words them otherwise, the key must be able to create a session, read it
   with the birth date expanded, cancel it and redact it, and nothing more. A restricted key, not
   the account's secret key: the box holds only what the check needs.
2. **A webhook endpoint** at the API's own host (the box's `PUBLIC_API_URL`), never at the website's
   `/backend` proxy: the proxy drops the `Stripe-Signature` header, and every delivery would fail.
   One path per environment, as in the table. Subscribe the six session events, and tick
   `.redacted` explicitly:

   ```
   identity.verification_session.canceled
   identity.verification_session.created
   identity.verification_session.processing
   identity.verification_session.redacted
   identity.verification_session.requires_input
   identity.verification_session.verified
   ```

   Copy its signing secret (`whsec_…`).
3. **The verification flow** of that mode (`vf_…`), made once in the dashboard. It asks for a
   document (passport, identity card or driving licence) and a selfie. On production a pass needs
   the face match: from a flow without the selfie, a verified session is refused by the record's
   rules (`identity_session_refused`, 0.4).

Then the box's settings, in its environment file (`.env.example` describes each):

```
STRIPE_IDENTITY_KEY=rk_test_…             # rk_live_… on mainnet
STRIPE_IDENTITY_FLOW_ID=vf_…
STRIPE_IDENTITY_WEBHOOK_SECRET=whsec_…
FORMATION_PII_KEY=…                       # openssl rand -base64 32, generated for this box
IDENTITY_NAME_HMAC_KEY=…                  # openssl rand -hex 32, generated for this box
WEB_ORIGIN=https://<the site's origin>    # a scheme and a host (a port if any): no '*', no path
OPENSANCTIONS_API_KEY=…                   # mainnet: a paid key (the smallest bundle, 500 credits)
```

A box that has neither `FORMATION_PII_KEY` nor `IDENTITY_NAME_HMAC_KEY` (the testnet box today)
gets both generated fresh for it, never the production ones. A box that holds them already keeps
them: a new PII key is a rotation, and the fingerprint key never changes (section 6).

Keys and secrets go into the password manager and the box's environment file, and nowhere else:
never into a chat, a ticket or the repo.

Restart, then check:

```bash
sudo systemctl restart legalbody-api
journalctl -u legalbody-api -n 200 | grep 'identity check: automatic'
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<api host>/webhooks/stripe-identity/sandbox
npm run cli -- scheduler:list
```

The curl answers 401: the route is live and refuses the unsigned request. A 404 means the path's
environment is not the box's (`/production` on mainnet), or the block is not set. `scheduler:list`
shows `identity_sessions_sync`, with its note "runs in the API process only", beside
`identity_sweep`.

The boot refuses, with the reason: one or two of the three `STRIPE_IDENTITY_*` settings without the
others; a live key on a testnet box, or a test key on a mainnet box; the block without
`FORMATION_PII_KEY`; the PII key without `IDENTITY_NAME_HMAC_KEY`; the block on mainnet without
`OPENSANCTIONS_API_KEY`; a `WEB_ORIGIN` that is not exactly a scheme and a host. A box whose doola
block is in sandbox (the testnet box) takes the PII key only with the block, and its formation still
refuses any SSN.

> **⚠ A testnet box never holds a production key.** Its `FORMATION_PII_KEY` and
> `IDENTITY_NAME_HMAC_KEY` are generated for it alone, and its Stripe key is a test key. The
> production keys stay on the production box and in the password manager.

### 0.2 The testnet is Stripe's test mode

The testnet box runs in Stripe's legacy **test mode**, not in a Stripe sandbox: a copied sandbox
asked for its own Identity application, and its account-holder verification step failed.

- Test mode shares its settings with live mode. Change settings in live mode only.
- In test mode, create only what belongs to the mode: the flow, the restricted key, and the webhook
  endpoint with its signing secret.
- The test page lets the person choose the outcome (a success, an expired document, and others): no
  document, no real person. Every row a sandbox writes is `synthetic`, and no production door ever
  counts one.
- Test mode returns one sample person for everyone, whatever name is typed. So the testnet does not
  compare the names: the typed name is recorded as typed, and no `name_mismatch` review comes. Nor
  does it run the duplicate check: a second account verified with the sample passes too. Production
  compares the names and runs the duplicate check. The operator's commands keep both rules
  everywhere.

### 0.3 Rotating the webhook secret

Zero downtime, as doola's (`doola-webhooks.md`): the box verifies each delivery against the current
and the previous secret.

1. In the dashboard, roll the endpoint's signing secret, and keep the old one valid for a day. While
   both are valid, Stripe signs each delivery with both.
2. On the box:

   ```
   STRIPE_IDENTITY_WEBHOOK_SECRET=<the new secret>
   STRIPE_IDENTITY_WEBHOOK_SECRET_PREVIOUS=<the secret in use until now>
   ```

3. `sudo systemctl restart legalbody-api`, then watch the deliveries:

   ```bash
   journalctl -u legalbody-api -f | grep -E 'identity_webhook_(received|unauthorized|dropped)'
   ```

4. Once the old secret has expired at Stripe and the deliveries still read
   `identity_webhook_received`, remove `STRIPE_IDENTITY_WEBHOOK_SECRET_PREVIOUS` and restart. Left
   set, it keeps a retired secret live.

### 0.4 Reading a session

The operator's tools:

```bash
npm run cli -- identity:session <tenantId>    # the open session, or the newest closed one
npm run cli -- identity:show <tenantId>       # the record the session wrote (prints the names)
npm run cli -- scheduler:list                 # the jobs, identity_sessions_sync among them
```

`identity:session` is read-only, writes no ops line and never prints a name. It shows our session
id; Stripe's session (`providerRef`, `vs_…`: search it in the dashboard) and report (`reportId`,
`vr_…`); the rows it points at (`startedCheckId`, `completedCheckId`); its dates; `lastStatus` and
`lastErrorCode` (Stripe's code, never its sentence); `failedAttempts` of `attemptsPerSession`;
`dobUnavailable`; `screenPendingSince`; whether it still holds the typed names (`typedNamesHeld`,
`typedErasedAt`); and the redaction (`redactDueAt`, `redactionRequestedAt`, `redactedAt`). `shown`
says which session it is: `open`, `newest_closed`, or `none`.

**The job.** `identity_sessions_sync` runs inside the API process, 30 seconds after boot and then
every `IDENTITY_SYNC_EVERY_MS` (ten minutes). Each pass reads the open sessions nobody read for two
minutes (50 at a time); closes those past `IDENTITY_SESSION_DAYS` as abandoned, after redacting or
canceling them at Stripe; gives a review's session its redaction date once the review is decided or
written over; and asks Stripe to redact the sessions due (again a week later, if a request did not
complete). Each pass writes `job_ran { name: "identity_sessions_sync", synced, abandoned,
redactRequested, redacted, errors, ms }`, or `job_failed` (CRITICAL from the third failure in a
row). It needs the API's
Stripe client and screener, so `scheduler:run identity_sessions_sync` is refused from the shell:
no command reads a session on demand. A session is read again by the next webhook, the guardian's
next return, or the job's next pass.

**The ops lines.** One JSON line each, ids, states and codes only: the tenant as its first ten
characters, our session id, never Stripe's.

```bash
journalctl -u legalbody-api --since today | grep -E '"opslog":"(identity_|person_screen_error)'
journalctl -u legalbody-api --since '7 days ago' | grep <sessionId>
```

| Line | What it means, and what to do |
| ---- | ----------------------------- |
| `identity_session_started { tenant, sessionId }` | A guardian started a check: a `started` row, a session at Stripe. |
| `identity_session_reused { tenant, sessionId }` | The guardian started again while their session waited for them: the same session, the new typed names, Stripe's fresh link. |
| `identity_webhook_received { environment, eventId, type, sessionId }` | Stripe woke us about one of our sessions; the read follows. |
| `identity_session_completed { tenant, sessionId, status, reviewReasons }` | A verified session became a row: `passed`, or `needs_review` with its reasons (0.5). The session is closed. |
| `identity_session_closed { tenant, sessionId, reasonCode }` | The session closed with a `failed` row: the last attempt failed, a code no retry changes, a cancellation or redaction at Stripe, or its days ran out (`abandoned`). `reasonCode` is the row's (section 1, step 5). A session Stripe had verified whose days ran out while it waited for its search or for you closes with `other`, never `abandoned`: the row's reason reads `verified at the provider; not completed within 14 days (screen_pending)`, or `(plan_refused)`, or `(no_typed_names)` (the days are `IDENTITY_SESSION_DAYS`). |
| `identity_session_superseded { sessionId }` | An operator's row was written for the guardian while the session was open: the session closed without a row of its own, its redaction due as after a row. Your row stands. |
| `identity_screen_pending { sessionId }` | The search gave no verdict: no row yet, the job tries again each pass. See below. |
| `identity_screen_pending_stale { sessionId, hours }` (CRITICAL) | The session has waited for its search more than 24 hours; written at each pass of the job that meets the session until the search answers, even a pass whose read of the session failed. A read in the two minutes before a pass (the guardian's return to the site, or the card's check) makes that pass skip the session, and its line. Read `person_screen_error`, then see below. |
| `person_screen_error { status }` (CRITICAL on 401, 402, 403; warn otherwise) | Why the search gave none: OpenSanctions' HTTP status, or `timeout`, `unreachable`, `unreadable`, `invalid_query`, `query_<status>`. A 401 or 403 is the OpenSanctions key, a 402 its credits spent: no check completes on production until it is fixed. |
| `identity_dob_not_read { sessionId }` | Stripe served no birth date for this session (a key without "Recent detailed verification results", or more than 48 hours after the document was processed): the search runs on the name alone. Said once per session. Repeated across sessions, check the key. |
| `identity_session_refused { sessionId, reason }` (CRITICAL on production, warn on a sandbox) | The session waits for an operator; written once, when the result is refused. See "A result the rules refuse" below. |
| `identity_session_waiting_operator { sessionId, ageHours }` (CRITICAL on production, warn on a sandbox) | The session still waits for an operator; written at each pass of the job that meets the session, until your row closes it or its days run out. A read in the two minutes before a pass (the guardian's return to the site, or the card's check) makes that pass skip the session, and its line. `ageHours` is the session's age since it started. See "A result the rules refuse" below. |
| `identity_session_dropped { sessionId, reason }` | A read came back in the other mode (`mode`) or naming another session (`reference`): nothing written. `mode`: the key and the box disagree. |
| `identity_session_unreadable { sessionId, field }` (error) | Stripe's answer lacked the shape we read, at the field named: nothing written, the caller got 503. Report it. |
| `identity_session_names_unreadable { sessionId, keyId }` (CRITICAL) | The typed names are sealed under a PII key this box no longer holds: configure the key `keyId` names again (section 6). |
| `identity_session_orphan_not_canceled { sessionId, status }` (warn) | Two starts of one account raced, or an operator's row was written for the account while Stripe made the session, and the session made at Stripe could not be canceled. The start reads its rules again over your row: a review or a pass of yours written while a start runs refuses that start, and no `started` row is written over it. No row points at it, and nobody holds its link. |
| `identity_provider_unavailable { op, status, code, requestId }` (warn) | Stripe did not answer (429, 5xx, a timeout): the caller got 503, the job reads again. Act if it lasts. |
| `identity_provider_error { op, status, code, requestId }` (error) | Stripe refused the call (another 4xx), with its machine code; `requestId` finds the request in Stripe's logs. |
| `identity_provider_key_rejected { op, status, code, requestId }` (CRITICAL) | Stripe refused the key (401, 403): wrong, revoked, or missing a permission. No check moves until the key is fixed (0.1). |
| `identity_provider_mode_mismatch { tenant, sessionId, livemode, environment }` (CRITICAL) | Stripe made a session in the other mode than the box's; nothing written. Check the key's prefix against `ARC_NETWORK`. |
| `identity_redaction_refused { sessionId, op, status, code }` (warn) | Stripe refused a redaction for good; it is asked again a week later. A session Stripe canceled on its own cannot be redacted, and its line comes back each week: delete that session in the dashboard. |
| `identity_review_waiting { sessionId, days }` (warn) | A review of the automatic check has waited more than 7 days for your decision; written at each pass until it is decided. Its session stays at Stripe until then (0.5, "The queue"). |
| `identity_sessions_sweep_error { step, sessionId, failure }` (warn) | One session failed in the job's pass (`sync`, `decision` or `redact`), with a refusal's code or an error's class; the others went on. The lines before it say why. |
| `identity_webhook_unauthorized { environment }` (warn) | A delivery failed the signature check: 401. Repeated, the box's secret is not the endpoint's (0.3). |
| `identity_webhook_oversize { environment }` (warn) | A body over 256 KiB: 413. Not Stripe's. |
| `identity_webhook_stale { environment, eventId, type }` (warn) | Authentic, but more than five minutes off our clock: ignored with 200. Check the clock (`timedatectl status`); the job reads the session anyway. |
| `identity_webhook_unparsable { environment }` (warn) | Authentic, but not an event: ignored with 200. |
| `identity_webhook_dropped { environment, eventId, type, reason }` | `mode` (warn): an event of the other mode, the endpoint is in the wrong mode. `no_session_object` (warn): a session event without its session, Stripe's shape changed. `unknown_session`: a session that is not ours (made in the dashboard, or by another box). |
| `identity_webhook_sync_failed { environment, eventId, type, sessionId, failure }` (warn) | The read the event woke failed, with its code or class; the job reads again. |
| `identity_webhook_task_failed { message }` (warn) | The webhook's background task failed outside its own wrapper, which catches a failed read and logs it as `identity_webhook_sync_failed` above. So it should never appear; it carries the thrown error's message, not a code, and no session id. Nothing is lost: the job reads every open session again at its next pass. Report it, with the lines around it. It is the identity check's only task line. |
| `identity_check_route_failed { route, errorName }` (error) | An identity check route met an error it did not expect, and answered 500. Report it. |

The operator's own commands write theirs (`identity_recorded`, `identity_accepted`,
`identity_refused`, `identity_revoked`, `identity_name_corrected`), as on the operator path.

**A search that gives no verdict** (`identity_screen_pending`). The session is verified at Stripe,
the search gave no verdict, and no row is written yet; the job tries again each pass. After 24
hours the job writes `identity_screen_pending_stale` (CRITICAL) at each pass. Read
`person_screen_error` first: a 401, 402 or 403 there (CRITICAL) is the key or its credits, and no
search runs until it is fixed. Stripe serves the birth date for 48 hours after the document is
processed: a search retried later runs on the name alone (`identity_dob_not_read`). Left alone,
the job closes the session after `IDENTITY_SESSION_DAYS` with a `failed` row whose reason code is
`other` and whose reason ends `(screen_pending)`: Stripe verified the person, so the row never says
the check was abandoned.

To finish by hand: search the name on OpenSanctions (section 1, step 4) with the birth date the
session shows in the dashboard, then record the check with `identity:record` (section 1, step 5),
`--expect-latest` the session's `started` row. Your row closes the session: at its next read by the
job, at its abandon, or at the guardian's next start, it closes without a row of its own
(`identity_session_superseded`), its redaction due as after a row. The job never writes over your
row, even should the search answer later. Check with `identity:session` and `identity:show`.

**A result the rules refuse** (`identity_session_refused`, CRITICAL on production, warn on a
sandbox). With `plan_refused`, the record's rules refused a verified result. On production that is
a session without the face match: the flow lacks the selfie (0.1), so fix the flow. The session
stays open, waiting for an operator: it is not read or searched again until an operator writes a
row for that guardian, and each pass of the job that meets it says so again
(`identity_session_waiting_operator { sessionId, ageHours }`, at the same level; a read of the
session by the guardian's return or the card's check in the two minutes before a pass makes that
pass skip it). Until it closes,
the guardian's start answers 409 `identity_under_review`. An operator's row closes it: record what
you read (`identity:record`), or refuse the attempt (`identity:refuse`, `--expect-latest` the
session's `started` row; during a renewal a refusal ends the earlier pass, "A renewal" below), and
the job's next pass closes the session without a row of its own (`identity_session_superseded`),
and the waiting line stops. Left alone, the job closes it after `IDENTITY_SESSION_DAYS` with a
`failed` row whose reason code is `other`, never `abandoned`, and whose reason reads `verified at
the provider; not completed within 14 days (plan_refused)`: Stripe verified the person, and the
row, kept for ever, must not say the check was left unfinished. With `no_typed_names`, the session
holds no typed name: that should never happen, so report it (its row's reason then ends
`(no_typed_names)`).

**A renewal.** A verified guardian may start the check again from 90 days before the pass expires
(`expiresAt`); earlier, the start answers 409 `identity_already_verified`. While the renewal runs,
the earlier pass keeps counting, under new attempts only: a `started` row, a failed attempt or a
review on top of it, written by the automatic check or recorded with `identity:record`, leave the
guardian `verified`. Written after the pass, a revocation, a review with `watchlist_hit` or
`country_blocked`, or any decision of yours (`identity:refuse`, `identity:accept` or
`identity:correct-name` on the renewal's rows, `identity:correct-name` on the pass itself) ends it:
the guardian then reads the state of the latest row. The new pass supersedes the earlier one, and
its expiry counts from its own completion. While a review is the latest row, the start answers 409
`identity_under_review`, even when the pass under it still counts.

**After a revocation.** A revocation is never undone without you. A session open when you revoke
closes without a row (your revocation is written over it). A check the guardian starts after the
revocation lands in review with `provider_flag`, never `passed`, whatever Stripe found (0.5).

### 0.5 A review from the adapter

A verified result lands in review (`needs_review`) for the reasons of section 2, read from the
session. `identity_session_completed` names them (`reviewReasons`), and so does `identity:show`.

| Reason | From the automatic check | Settle it with |
| ------ | ------------------------ | -------------- |
| `name_mismatch` | **New**: the typed name and the document's differ beyond case and spacing. Production only: the testnet does not compare (0.2). | Compare in the dashboard and ask the guardian, then `identity:correct-name` to the name the document prints, with your search on that name (section 4), or `identity:refuse`. `identity:accept` refuses this reason. |
| `watchlist_hit` | The sanctions and PEP search found a possible match. | Search OpenSanctions by hand with the name and the birth date the session shows: `identity:accept --reason-code watchlist_false_positive`, or `identity:refuse --reason-code watchlist_confirmed`. |
| `country_blocked` | The document's country is in `SCREENING_BLOCKED_COUNTRIES`. | `identity:refuse --reason-code country_blocked`. |
| `name_rule_failed` | The typed name breaks the name rule. | `identity:correct-name` when the document shows a usable name; else section 2's note. |
| `duplicate_identity` | Another account holds a current pass with the same name and document country, a pass under a renewal under way included. Production only (0.2). | Section 2 finds the other account; then decide (section 3). |
| `provider_flag` | The document's country has no ISO 3166-1 code (Kosovo's `XK`); `documentCountry` is then empty, and in `identity:show` the review's `recorded` event reads `reasonCode: country_outside_iso`. A pass needs a document country, so `identity:accept` is refused. | `identity:refuse --reason-code other` (the reason: the document's country is outside ISO 3166-1); the guardian verifies again with another document. |
| `provider_flag`, after a revocation | The guardian's record holds a revocation after its last pass (0.4, "After a revocation"): `identity:show` lists a `revoked` row after the last `passed` one, and the review's `recorded` event reads `reasonCode: after_revocation`. When the document's country is outside ISO 3166-1 as well, the event names the revocation and `documentCountry` is empty: the review cannot pass, so refuse it as in the row above. | Read why the pass was revoked (`identity:show`, the revocation's reason code). `identity:accept --reason-code provider_flag_cleared` once that cause no longer holds, or `identity:refuse`. |

Each decision also takes `--operator`, `--expect-latest <the review's check id>`, a `--reason` and
`--yes`, as section 3 says.

**Comparing in the dashboard.** Find the session by its `vs_` id (`providerRef` in
`identity:session`). A review's session is not redacted until a decision row supersedes the review,
or a row is written over it, so it still shows the document, the selfie and the extracted data. Do
not redact it by hand: the job redacts it `IDENTITY_REDACT_AFTER_DAYS` after it sees the decision.

**The queue.** The decisions that count are `identity:accept`, `identity:refuse` and
`identity:correct-name` (a correction that leaves the check in review counts once the next decision
settles it). A new check recorded over the review with `identity:record` is not a decision, but the
review is then no longer the guardian's standing row: the job gives its session its redaction date
all the same. While a review is the latest row, the guardian's start answers 409
`identity_under_review`, so no new session is opened over it. A review nobody decides is never
redacted at Stripe: it is the operator's queue, and after 7 days the job says so at each pass
(`identity_review_waiting { sessionId, days }`, warn). To list the reviews of the automatic check
that wait:

```bash
sqlite3 -readonly -cmd ".timeout 5000" "$DATA_DIR/legalbody.db" \
  "SELECT session_id, tenant_id, completed_check_id, datetime(closed_at / 1000, 'unixepoch')
     FROM identity_sessions
    WHERE closed_at IS NOT NULL AND completed_check_id IS NOT NULL
      AND redact_due_at IS NULL AND redacted_at IS NULL
    ORDER BY closed_at;"
journalctl -u legalbody-api --since '30 days ago' | grep identity_session_completed | grep needs_review
```

then `identity:show <tenant_id>` for each. A review decided since the job's last pass stays on the
list until its next one.

**A confirmed sanctions match during a renewal.** A refusal ends an earlier pass that still counts:
it is your decision on the renewal, and after it `identity:show` reads `failed`, whatever the
review's reasons. No revocation is needed, and `identity:revoke` is refused, since no pass counts:

```bash
npm run cli -- identity:refuse <tenantId> --reason-code watchlist_confirmed \
  --reason '<ids and facts, no name>' --operator <your operator name> \
  --expect-latest <the review's check id> --yes
npm run cli -- identity:show <tenantId>
```

A live company is its own decision (`company:revoke`, section 3).

### 0.6 What is never there

- **The document and selfie images, the document number**: never fetched. A read expands the
  verified outputs and the last report, nothing else.
- **The address**: Stripe returns the document's address with any read that expands the verified
  outputs, and its API cannot leave it out. It is never read out of the answer, never stored, never
  logged.
- **The birth date**: its one use is the sanctions query, and it is never stored or logged. That
  query, to OpenSanctions' match API, is the one place it passes; a sandbox without the key sends it
  nowhere.
- **Stripe's extracted names**: compared with the typed names, then dropped.
- **The typed names**: sealed under the PII key in the session row, and only until the session
  closes.
- **Stripe's error sentence** (`last_error.reason`): never read; its code only.

### 0.7 What the guardian sees

Where the block is set, the site's human step shows the check on one card: on `/start`, and on
`/legal-body` at "Accountable human". Under its title the card says "World ID proves one real
person. The identity check says who." It never names Stripe or the search: the guardian's privacy
notice does. On the testnet it says the check is optional and a test check; on production, that it
is required before a legal body is created.

The card decides from two reads only: the record (`identity.state` in `GET /world-id/me`, the
state `identity:show` reads) and the open session (`GET /identity-check/session`). In
`identity:session`, the session view's `reading` is `lastStatus` `processing`, and its `held` is
`lastStatus` `verified`: `system` while `screenPendingSince` is set, `operator` once it is not.
A record in review shows the review sentence whatever the session. Otherwise an open session
decides, and with none the record does.

Stripe sends the person back to `WEB_ORIGIN`, on the page they started from, with
`?identityCheck=returned`. When the card opens on an open session that is not held, it reads it back
once (`POST /identity-check/sync`), whichever way the person came back. It never reads back a held
session: the job reads one held for the search, and one held for an operator waits for your row.

`{date}` and `{n}` are filled in on the page.

| The card says | The record and the session | What you do |
| ------------- | -------------------------- | ----------- |
| The name form and "Start the check". On production it opens with "You leave this site for our identity check provider's page." On the testnet: "Test check. You leave this site for our identity check provider's test page, pick an outcome there, and come back here." | `none` or `pending`, no open session. | Nothing. The guardian types the name and starts (0, step 1). |
| "Your check is open and not finished. Continue it below." The name form again ("Type your name again: it is not kept in this browser.") and "Continue the check". | An open session the person has not finished: `lastStatus` null or `requires_input`, no `lastErrorCode`. | Nothing. Each start answers a fresh link to the same session (`identity_session_reused`). Left alone, it closes as `abandoned` after `IDENTITY_SESSION_DAYS` (14). |
| "That attempt did not go through.", then the reason, then "{n} attempts left on this check." (or "1 attempt left on this check.") and "Try again". | An open session with a `lastErrorCode` and `failedAttempts` below `attemptsPerSession`. The reason is the card's own sentence for Stripe's code; a code it does not list reads "Try again, or use another document." | Nothing. The attempt that reaches the limit closes the session with a `failed` row (`identity_session_closed`). |
| "Your result is being read. This page checks again by itself." After three minutes: "Still being read. This can take a few minutes. You can leave this page: the result is kept, and it shows here when you come back." and "Check again". | An open session, `lastStatus` `processing`. For three minutes the page reads the record and the session every five seconds, and asks for a read at Stripe every 20 seconds. | Nothing, while it lasts minutes. Hours: look for `identity_provider_unavailable` and the `identity_webhook_` lines (0.4). The job reads the session at each pass. |
| "Your part is done. We are finishing the check on our side, and this page shows the result when it is ready. Nothing more to do now. If it still says this tomorrow, write to us." No button. | An open session, `lastStatus` `verified`, `screenPendingSince` set (`held` `system`): the search gave no verdict (`identity_screen_pending`). | Read `person_screen_error` (0.4, "A search that gives no verdict"): a 401, 402 or 403 is the key or its credits. Fix it, or finish by hand. |
| "Your part is done. A person at Novi Corpus is looking at the result, usually within one working day. Nothing more to do now: this page shows the result once it is decided." No button. | The record `needs_review` (section 2, 0.5), whatever the session. Or an open session, `lastStatus` `verified`, `screenPendingSince` null (`held` `operator`): `identity_session_refused`, then `identity_session_waiting_operator` (0.4, "A result the rules refuse"). Or a renewal whose start answered `identity_under_review`. | Decide the review (section 3), or write the row the session waits for (0.4). Until then the guardian's start answers 409 `identity_under_review`. |
| "The last check did not go through. You can start a new one, or write to us." and "Start a new check". | The record `failed`, no open session, whatever the row's reason: the last attempt failed, a code no retry changes, a cancellation or redaction at Stripe, a session closed after `IDENTITY_SESSION_DAYS` (`abandoned`, or `other` when Stripe had verified the person), or an operator's failed row (`identity:refuse`, `identity:record --result failed`). The card never says why. | When the guardian writes, read the row's reason in `identity:show`. A reason that ends `(screen_pending)` or `(plan_refused)`: Stripe verified the person, so fix the cause (0.4) before they start again, or the new check stops at the same place. |
| "Verified on {date}". On the testnet: "Verified on {date} (test check)" and "A test check counts on the testnet only." No form, no button. | The record `verified`, more than 90 days before its `expiresAt`, no open session. | Nothing. A testnet row is `synthetic`: no production door counts it (0.2). |
| The verified line, then "Due again on {date}. You can renew now. Your current check counts until then." and "Renew now". | The record `verified`, its `expiresAt` within 90 days, no open session. The browser's clock decides when the line shows; the server decides whether a renewal may start (`identity_already_verified` earlier). | Nothing. No email says it: only the human step does. |

During a renewal the verified line stays above the card's sentence for as long as the earlier pass
counts (0.4, "A renewal").

## 1. The operator path, when the automatic check is not there

On a box without the Stripe Identity block, during a Stripe outage, or to finish a check the
automatic path could not (0.4), an operator runs the check by hand, one guardian at a time:

1. **The link.** In the Stripe dashboard, open the guardian-check Verification Flow and copy its
   static link. Append a fresh opaque reference and the person's email address:

   ```
   <flow link>?client_reference_id=<reference>&prefilled_email=<the person's address>
   ```

   The reference is new for every request (`openssl rand -hex 8` is enough). It is **never** the
   tenant id and never the World ID nullifier: the session lives at Stripe, and neither belongs
   there. Note the reference beside the tenant id wherever you track the request, without the name.

2. **Send it, and ask for the name.** With `email:send-link` from the box (PR 2a), or, until PR 2a
   is deployed, from the contact mailbox. Send the flow link only: it is made to be shared. The
   dashboard's single-use session links expire after 48 hours and are not sent by email, as Stripe
   advises. In the same email (or a follow-up), ask the guardian for their legal name **exactly as
   printed on the document** they will show: first name, last name, and the full name if the
   document prints more.

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
included, so a renewal may land in review. What the guardian then reads follows the renewal rule
(0.4, "A renewal"): a review with `watchlist_hit` or `country_blocked` ends the earlier pass, and
the guardian reads `needs_review` until you decide it; a review for any other reason (a duplicate,
a name that differs, a name that breaks the rule, a document out of date) leaves the guardian
`verified` on the earlier pass, while that pass is in date. Your decision on the review
(`identity:accept`, `identity:refuse` or `identity:correct-name`) ends the earlier pass either way:
the guardian then reads the state of the row you wrote. A failed session over a verified guardian
is not recorded as such: revoke first if the guardian must lose the pass.

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

The automatic check writes the same reasons from what it reads (0.5).

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

A decision written while a renewal is under way ends the earlier pass (0.4, "A renewal"): after it
the guardian reads the state of the row you wrote, not the old pass.

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
npm run cli -- identity:correct-name <tenantId> --names-prompt --watchlist clear \
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
made on the old name. Pass what you found: `--watchlist clear`, or `--watchlist hit` for a possible
match, which writes the search on the row and leaves the correction in review with
`watchlist_hit`; decide it then as section 3 says (`watchlist_false_positive` or
`watchlist_confirmed`). On production `--watchlist` is required, and the command refuses without it;
on a sandbox, without it the check's search is carried over.

A correction of a passed check ends that pass: when the correction lands in review (another
account's pass holds the new name, or the search hit), the guardian reads `needs_review` until you
decide it.

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
document number. The operator redacts within the week; the automatic check asks Stripe
`IDENTITY_REDACT_AFTER_DAYS` (seven) days after its row, or after the decision of its review, and
until then the session is at Stripe. What we hold is the record itself: the result, the dates, the
document's country and type, and the names of record, encrypted.

## 8. First run against Stripe's test mode

The run can be done without the Stripe CLI. Without `stripe listen`, set
`STRIPE_IDENTITY_WEBHOOK_SECRET` to any local `whsec_` value. The job then reads each open session
every `IDENTITY_SYNC_EVERY_MS`. Only the webhook delivery itself is not exercised. If another local
API already uses port 8789, set `PORT` in the run's env file and use that port in every command.

A one-off run on a builder's machine, before the testnet box gets the block. It needs the
test-mode restricted key and flow (0.1, 0.2), the Stripe CLI signed in to the account
(`stripe login`; `stripe listen` stays in test mode unless told otherwise), and a test wallet. It
confirms eight facts the tests cannot:

1. Stripe accepts both `verified_outputs` and `verified_outputs.dob` as expands in one read.
2. A redaction cancels a session still waiting for the person.
3. Stripe's ids are `vs_` (a session) and `vr_` (a report) followed by letters and digits only.
4. Stripe makes a new VerificationReport (`vr_`) for every failed attempt, in test mode too: the
   count of attempts rests on it.
5. A read after a failed attempt returns a fresh `url` that opens Stripe's page again.
6. Stripe takes `return_url` beside `verification_flow` when it creates a session.
7. Test mode returns one sample person for everyone (0.2): the same names for every verified
   session, whatever was typed. The testnet does not compare names.
8. A verified session's passed row carries `liveness` `passed`, a `documentCountry` and a
   `documentType`, read in `identity:show` at step 7. A row without a document type passes on
   mainnet too, so this run is the only place that catches a mapping error there. A sandbox row
   also passes without the face match, which mainnet would refuse and park for an operator
   (`plan_refused`). (A row without a document country passes nowhere: it lands in review,
   `country_outside_iso`.)

**1. Forward Stripe's events to the local API** (port 8789, the `PORT` default), in a terminal of
its own, for the whole run:

```bash
stripe listen --forward-to localhost:8789/webhooks/stripe-identity/sandbox \
  --events identity.verification_session.canceled,identity.verification_session.created,identity.verification_session.processing,identity.verification_session.redacted,identity.verification_session.requires_input,identity.verification_session.verified
```

It prints a signing secret (`whsec_…`): the run's `STRIPE_IDENTITY_WEBHOOK_SECRET`. If it stops,
the job still reads each open session at its next pass.

**2. The run's settings**, in `back/backend/.env.sandbox` (made from `.env.sandbox.example`, see
`world-sandbox-testing.md`; git-ignored), with `ARC_NETWORK` testnet:

```
WEB_ORIGIN=http://localhost:3000
FORMATION_PII_KEY=<openssl rand -base64 32>      # fresh, for this run only
IDENTITY_NAME_HMAC_KEY=<openssl rand -hex 32>    # fresh, for this run only
STRIPE_IDENTITY_KEY=rk_test_…
STRIPE_IDENTITY_FLOW_ID=vf_…                     # the test-mode flow
STRIPE_IDENTITY_WEBHOOK_SECRET=whsec_…           # the one stripe listen printed
IDENTITY_SESSION_MAX_PER_DAY=10                  # the run opens three sessions on one account
IDENTITY_SYNC_EVERY_MS=60000                     # the job every minute
```

No `OPENSANCTIONS_API_KEY`: no search runs (`watchlist: not_run`). The example file's warning
against a PII key holds without the Stripe block only: with the block, the box takes the key.
`/world-id/me` carries its `identity` block only where the legal-body doors are mounted
(`LEGAL_BODY_FACTORY_ADDRESS` set); without them, `identity:show` reads the same record.

**3. Start the API**, keeping its output:

```bash
cd back/backend
npm run api:sandbox 2>&1 | tee ~/identity-first-run.log
```

The boot prints `⚠ identity check: automatic (stripe, test), offered`. In another terminal, run the
operator commands on the same file. `DOTENV_CONFIG_PATH` does not reach them: they load `.env`
themselves, so the file goes in through Node's `--env-file`, and `.env`, if there is one, fills
only what `.env.sandbox` leaves unset:

```bash
cd back/backend
cli() { ./node_modules/.bin/tsx --env-file=.env.sandbox src/cli/index.ts "$@"; }
cli scheduler:list      # identity_sessions_sync, with its note
```

**4. Sign in, and give the account a World ID row.** Sign in with the test wallet: the local
interface does it (`npm run dev` in `interface/`, which talks to `localhost:8789`), or by hand as
`back/backend/README.md` says ("Auth"). The site's local run needs `WEB_ORIGIN=http://localhost:3000`
(step 2), and a Vercel preview cannot be used for the return: the person comes back to
`WEB_ORIGIN`, not to the preview. Copy the `token` of the `auth/verify` answer. The check
needs a World ID verification of the guardian action: verify with the sandbox World App
(`world-sandbox-testing.md`), or redeem a waiver code, which a sandbox takes:

```bash
cli waiver create --note 'identity check first run'    # prints nvw_…
API=http://localhost:8789
TOKEN='<the session token>'
curl -s -X POST "$API/world-id/waiver" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"code":"nvw_…"}'
```

The names typed below are test names, never a real person's.

**5. A waiting session, redacted (fact 2).** Start a session and leave it waiting:

```bash
curl -s -X POST "$API/identity-check/sessions" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"firstName":"Test","lastName":"Person"}'
cli identity:session <tenantId>     # shown: open, providerRef: vs_…, lastStatus: requires_input
stripe post /v1/identity/verification_sessions/<vs_…>/redact
stripe get /v1/identity/verification_sessions/<vs_…>
```

The start answers 201 with `sessionId`, `url` and `expiresAt` (`lastStatus` is null until the first
read). Fact 6 holds when it does: the session was created with the flow and the return URL. Fact 2
holds when the read shows `"status": "canceled"` beside its `redaction`. The
`.redacted` event arrives (`identity_webhook_received` with `type`
`identity.verification_session.redacted`); its read writes no row, and `identity:session` shows
`redactedAt` once Stripe says `redacted`.

**6. "Verification failure", three times.** Start again with the same command: the redacted session
closes as abandoned (`identity_session_closed`, `reasonCode` `abandoned`) and a new one opens
(`identity_session_started`). Open the answer's `url` and choose "Verification failure" on the
test page ("Complete with test data"). Then:

```bash
cli identity:session <tenantId>     # open, lastErrorCode: document_unverified_other, failedAttempts: 1
curl -s -X POST "$API/identity-check/sync" -H "Authorization: Bearer $TOKEN"
                                    # {"outcome":"attempt_failed","state":"pending"}
```

Start again (the same `sessionId` with a fresh `url`, `identity_session_reused`) and fail twice
more. Fact 5 holds when each fresh `url` opens Stripe's page again; fact 4 when `failedAttempts`
moves by one at each failure, never more and never less (each failure its own `vr_` report, which
`stripe get /v1/identity/verification_sessions/<vs_…>` shows as `last_verification_report`). The
third failure closes the session: `identity_session_closed` with `reasonCode`
`document_unverified`. `identity:session` then shows `newest_closed`, `failedAttempts` 3, a
`completedCheckId` and a `redactDueAt`, and `/world-id/me` reads `"state": "failed"` in its
`identity` block:

```bash
curl -s "$API/world-id/me" -H "Authorization: Bearer $TOKEN"
```

The test page offers five outcomes: "Verification success", "Verification failure", "Verification
success async", "Verification failure async" and "Consent declined". "Consent declined" closes the
session at once (a final code). The async variants pass through `processing` first.

**7. "Verification success" (facts 1, 3, 7 and 8).** Start again, with any test name, and choose
"Verification success". The `processing` and `verified` events arrive, then
`identity_session_completed` with `status` `passed`: the testnet does not compare the typed name
with the sample's (0.2), so a name that differs from it passes too, recorded as typed. Fact 7 holds
when the dashboard's verified outputs for this session are a sample name you did not type, the
check passed all the same, and any other verified test session of the account shows the same
sample. Say only whether it holds, never the names. The job (every `IDENTITY_SYNC_EVERY_MS`) completed the session on its own before the guardian's
sync, so the sync answers `unchanged`. Then:

- `identity:session`: `newest_closed`, `lastStatus` `verified`, `dobUnavailable` `false`,
  `typedNamesHeld` `false`, and a `redactDueAt` seven days after `closedAt`;
- `POST /identity-check/sync`: `{"outcome":"unchanged","state":"verified"}` (no open session);
- `/world-id/me`: `identity` reads `"required": false`, `"automatic": true`, `"state": "verified"`,
  with the typed names and the dates;
- `identity:show`: the passed row, `synthetic` `true`, `watchlist` `not_run`, `operator` null, and
  its event by `system`. Fact 8 holds when that row reads `liveness` `passed`, a three-letter
  `documentCountry` and a `documentType` (`passport`, `identity_card` or `driving_licence`); say
  only which hold, never the names.

Fact 1 holds when no `identity_dob_not_read` line came and `dobUnavailable` is `false`. A line means
Stripe refused the read with the birth date or served none: check that the key has "Recent detailed
verification results: Read", and note at which step the line came. Fact 3 holds when `providerRef`
and `reportId` read `vs_` and `vr_` followed by letters and digits only, and no
`identity_session_unreadable` line came.

The redaction of a finished session falls due `IDENTITY_REDACT_AFTER_DAYS` after its row (one day at
the least). The job's tests cover it; waiting for it is optional.

**8. What to send back.** The ops lines of the run, which carry ids, states and codes, never a name:

```bash
grep -E '"opslog":"(identity_|person_screen_error|job_ran|job_failed)' ~/identity-first-run.log
```

the eight facts (each holds, or the line that says it does not), and the `identity:session` outputs
with `providerRef` and `reportId` cut to their prefix. Never the output of `identity:show` or
`/world-id/me` (they print the names), a key, the `whsec_` secret, the flow id or a session `url`.

Afterwards, the run's database is disposable (`rm -rf back/backend/data-sandbox`), and so is the
log.
