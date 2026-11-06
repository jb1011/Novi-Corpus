# Runbook: email (the outbox, Resend, the operator's email commands)

Every email the product sends is a row in the outbox (`email_outbox`) first. One path sends it:
the scheduler's `email_deliver` job, inside the API, every 30 seconds, through the deployment's
sender. The mainnet box sends through **Resend** (US region). The staging instance runs the
**console sender**, which sends nothing and writes one `email_console` ops line per email. The
testnet box has no email system at all (it sets no `PUBLIC_APP_URL`) and sends nothing.

Every command below runs on the box, from the backend directory:

```bash
npm run cli -- email:list --status failed
```

**Never put an address in a ticket, a chat or a commit.** Not a customer's, not a guardian's, not
in a screenshot of the provider's dashboard. Ops lines and `email:list` carry ids, kinds, states
and codes, never an address or a body. The outbox keeps the address and the body only until the
email is sent; a sent row keeps its subject, kind, ids and states. Only two commands take an
address, `email:send-link` and `email:resend`, and neither prints it back.

**Type the address at the prompt, `--to-prompt`**, never on the command line: an address on the
command line stays in the shell history and shows in the process list. At a terminal the command
asks `Email address: ` on standard error; from a pipe it reads the first line. `--to <address>`
exists for scripts and is refused together with `--to-prompt`. A configuration without the email
system is refused before the prompt.

Code: `back/backend/src/email/` (the outbox, the senders, the identity-link template),
`back/backend/src/api/routes/emailWebhook.ts`, `back/backend/src/cli/email.ts`.

## 1. The settings

`PUBLIC_APP_URL` turns the email system on. Without it there is no sender, no `email_deliver` job,
no webhook route, and the `email:*` commands refuse (`email is not configured on this deployment
(PUBLIC_APP_URL)`).

| Setting                       | Where                    | What it is                                                                                     |
| ----------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------- |
| `PUBLIC_APP_URL`              | staging, mainnet         | The app's public origin; every link in an email is built on it. https with `resend`.          |
| `EMAIL_FROM`                  | staging, mainnet         | `Name <address>` on a sending domain (section 2), or an address.                               |
| `EMAIL_POSTAL_ADDRESS`        | staging, mainnet         | The company's postal address, one line, at the foot of every email.                            |
| `EMAIL_REPLY_TO`              | optional                 | A plain address for replies, when not `EMAIL_FROM`. The identity-link email asks for a reply (section 6). |
| `EMAIL_PROVIDER`              | mainnet: `resend`        | `resend` or `console` (the default).                                                           |
| `RESEND_API_KEY`              | mainnet only             | A secret. Required with `resend`; refused with `console`.                                      |
| `RESEND_WEBHOOK_SECRET`       | mainnet only             | A secret, `whsec_` then base64 (section 3). Required with `resend`; refused with `console`.    |
| `RESEND_MARKETING_SEGMENT_ID` | optional                 | The campaign's segment. Without it contact writes are skipped (section 6).                    |
| `EMAIL_CONSOLE_SHOW_BODY`     | staging only             | `true`: the console sender prints each text body (section 7). Refused with the provider sender (`resend`). |

The two secrets go into the mainnet environment file only, never into a chat, a ticket, a commit
or the staging instance. The box refuses to boot on a half-configured block: `resend` without
its key, its secret, `EMAIL_FROM`, `EMAIL_POSTAL_ADDRESS` or `PUBLIC_APP_URL`; any email setting
without `PUBLIC_APP_URL`; the key or the secret with `console`; with `resend`, an http
`PUBLIC_APP_URL` or `EMAIL_CONSOLE_SHOW_BODY`, on any deployment. The console sender may run in
production mode (`ARC_NETWORK=mainnet`, the staging proof) with both.

## 2. The two sending domains and their records

Two domains in Resend's US region, each with its own records on Cloudflare:

| Domain                | Sends                                                              |
| --------------------- | ------------------------------------------------------------------ |
| `novicorpus.com`      | The product's own email: filings, the waitlist, invites, identity links. `EMAIL_FROM` is on it. |
| `news.novicorpus.com` | The campaign to the marketing segment, and nothing else.          |

The campaign is kept on its own domain so that its complaints never weigh on the reputation of
the filing and account mail.

For each domain, add in Cloudflare exactly the records the provider's domain page shows. They are
per domain and per region: copy them from that page, never from memory or from this file.

- **DKIM**: the TXT record under `_domainkey` that carries the provider's public key.
- **SPF**: the records on the return-path subdomain the provider names (an MX and a TXT). A name
  holds one SPF record: where one exists already, merge the provider's `include:` into it, never
  add a second.
- **DMARC**: the TXT record at `_dmarc`, which the provider does not create. A domain holds one.
  If `_dmarc.novicorpus.com` exists already (the company's own mailbox), keep it and do not add a
  second; `news.novicorpus.com` follows it (its `sp=` tag) unless it has its own. Start with
  `p=none` and a reporting address; move to `p=quarantine` once the reports show only our own
  senders passing.

Any CNAME the provider gives is set to **DNS only** (grey cloud), never proxied. MX and TXT
records are never proxied anyway.

Then wait until the provider's domain page shows every record verified, and make the live send
the merge gate asks for: one email to a founder's own address from a non-production box with the
real key, and the same contact written twice. That box runs `EMAIL_PROVIDER=resend`, so its
`PUBLIC_APP_URL` must be an https origin: an http value is refused with the provider sender
(section 1). In the received email's headers, `dkim=pass`, `spf=pass` and `dmarc=pass`.

## 3. The delivery webhook

The provider tells us what happened to each sent email through a Svix-signed webhook:

```
POST https://<api host>/email/webhook/resend
```

**The backend's own origin, never the web proxy.** The proxy forwards a fixed list of headers and
the `svix-*` signature headers are not on it: every event through it would be refused (the doola
webhook's lesson, docs/runbooks/doola-webhooks.md).

In the provider's dashboard, create the endpoint and subscribe it to the six delivery events, and
only those:

| Event                    | Recorded on the row as |
| ------------------------ | ---------------------- |
| `email.delivered`        | `delivered`            |
| `email.delivery_delayed` | `delayed`              |
| `email.bounced`          | `bounced`              |
| `email.complained`       | `complained`           |
| `email.failed`           | `failed`               |
| `email.suppressed`       | `suppressed`           |

Any other event (sent, opened, clicked and the rest) is answered 200 and written nowhere: we do not
track opens or clicks, so do not subscribe to them.

Copy the endpoint's signing secret (`whsec_` then base64) into `RESEND_WEBHOOK_SECRET` in the
mainnet environment only, then restart the API. Its key must decode to at least 16 bytes: the box
refuses to boot on a shorter one. The route exists only with `EMAIL_PROVIDER=resend`; elsewhere
the path answers 404.

| Case                                                        | Answer | Ops line                              |
| ----------------------------------------------------------- | ------ | ------------------------------------- |
| Body over 16 KiB                                            | 413    | `email_webhook_oversize` (warn)       |
| A missing header, a timestamp more than 5 minutes off, a wrong signature | 401 | `email_webhook_unauthorized` (warn) with the reason code |
| Signed, but not an event, or a delivery event without an email id | 200 | `email_webhook_unparsable` (warn) |
| Signed, any other event (sent, opened, clicked, ...)        | 200    | none                                  |
| Signed, a delivery event for an id no sent email carries    | 200    | `email_delivery_unmatched` (info); the event is kept (below) |
| Signed, a delivery event                                    | 200    | `email_bounced` (WARN) for bounced, complained, failed, suppressed |

The row keeps the newest event by the event's own time; an older or redelivered event changes
nothing and writes no line, and `delayed` never overwrites an outcome.

A delivery event can arrive before its email's row holds the provider's id: the send's answer
was lost (the provider took the email; the row is still pending and is retried under the same
key, which the provider answers with the same id), or an `email.suppressed` raced the send. Such
an event is kept in `email_delivery_orphans` (the id, the state, two times; never the address).
When the delivery job marks a row sent with that id, it applies the kept events by the same
rules and deletes them, and an undelivered end state writes its `email_bounced` WARN line then.
The kept events no row ever claims (the campaign's emails reach the same endpoint) are deleted by
the delivery job 7 days after they arrived.

To rotate the secret: rotate it in the dashboard, set the new value, restart the API. Events
refused in between are retried by the provider (immediately, then after 5 s, 5 min, 30 min, 2 h,
5 h, 10 h and 10 h), so a restart within minutes loses none.

## 4. How an email moves, and the daily check

- **pending**: queued, due now or at its next attempt.
- **sent**: the provider took it (or, on the console sender, its line was written). The address
  and the body are cleared. The webhook then records its **delivery state**.
- **failed**: the provider refused it for good (a 4xx, but for a 429 and a 409
  `concurrent_idempotent_requests`), or a retryable error (a timeout, a network error, a 429, a
  5xx) came back nine times. The row keeps its address and its body for
  `email:resend`. Retries wait 2, 4, 8, 16, 32, 60, 60 and 60 minutes; each writes an
  `email_retry` warning, and the failure writes a CRITICAL `email_failed` line with the HTTP
  status and the provider's code. A 429 `daily_quota_exceeded` or `monthly_quota_exceeded` will
  not clear by waiting: raise the plan, then re-queue.

A row's `failed` status (the outbox's) is not a `failed` delivery state (the provider's event on
a sent email). A failed row may still be one whose send the provider took: an answer lost on the
way, then refusals, look the same from here, and the provider holds the row's key for 24 hours
(section 6, `email:resend`). Either way, treat it as an email the customer did not get.

**Every working day**, look at what did not arrive:

```bash
npm run cli -- email:list --status failed --since <yesterday, 2026-11-09>
npm run cli --silent -- email:list --status sent --since <yesterday, 2026-11-09> \
  | jq '.emails[] | select(.deliveryState != null and .deliveryState != "delivered" and .deliveryState != "delayed")'
journalctl -u legalbody-api --since yesterday | grep -E '"opslog":"(email_failed|email_bounced)"'
```

The second line keeps the sent emails whose delivery state is an outcome other than `delivered`;
without `jq` on the box, read `deliveryState` in the list by eye. Each line or row names the email
id, its kind and its subject reference (a company id, a waitlist entry, an invite hash, a tenant
id cut to ten characters in the log). Act on each by its kind (section 5). `email:list` takes `--kind <kind>` and `--since <date or ISO time>` too, and writes
nothing.

A manual delivery run, in the CLI's own process: `npm run cli -- scheduler:run email_deliver
--yes`. The API's job keeps running beside it; the idempotency key and the guarded writes keep the
two from sending an email twice. When both sent the same row, the one that recorded it second
writes an `email_sent_unrecorded` warning (the email id and kind) and does not count it: the
provider answered both under the same key, with one email.

## 5. What an undelivered email means, by kind

A **bounce** is an address that does not take mail. A **complaint** is the person marking the email
as spam. A **suppression** is the provider not sending to an address on its suppression list (an
earlier hard bounce or complaint). A **failed** delivery is the provider unable to send at all.

| Kind               | What did not arrive                          | What to do                                                                                                       |
| ------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `filing_landed`    | The customer's news that their filing landed | **Reach the customer another way the same day** (the contact on the company's record, the contact mailbox): nothing else in the product tells them. |
| `identity_link`    | The guardian's link to the identity check    | Confirm the address with the guardian another way, then send a new link the same day with `email:send-link --again` (section 6): it queues a new row under the day's key and the next number (`identity_link:<digest>:<day>:2`, then `:3`), so the provider never answers it with the earlier send. `--again` is taken only when the day's latest link failed, or was sent and bounced, complained, failed or was suppressed; it is refused while that link is pending, sent with no outcome yet, delayed or delivered, and on a day with no link yet. Without `--again` the command stays one link per guardian per UTC day. Meanwhile the contact mailbox may send the same link. |
| `invite_code`      | The person's invite                          | Confirm the address another way and invite them again to the right one.                                          |
| `waitlist_confirm` | The confirmation of a waitlist entry         | Nothing: the entry stays unconfirmed. The person typed a wrong address, or will write in.                       |
| `contact_upsert`   | Not an email: an address for the campaign's segment | No delivery events. A failed row means the address is not in the segment; re-queue it under its own address, or leave it. |

After a **complaint**, send that person nothing more by email unless they ask; for a filing,
reach them another way. After a **suppression**, remove the address from the provider's
suppression list only once the person has confirmed in writing that it works (and, after a
complaint, that they want our email). Several **failed** deliveries in a row point at the domain:
check its records first (section 2).

## 6. The commands

### `email:list`

```bash
npm run cli -- email:list [--status pending|sent|failed] [--kind <kind>] [--since <date>]
```

The newest `--limit` rows (100 by default, at most 1000), printed the oldest first: `emailId`,
`kind`, `subjectRef`, `subject`, `status`, `attempts`, `nextAttemptAt`, `providerMessageId`,
`deliveryState`, `deliveryAt`, `lastError`, `createdAt`, `sentAt`. When older rows were left out
the output says `more: true`: narrow the list or raise `--limit`. Never an address, a body or an
idempotency key. `--since` is a UTC date (`2026-11-10`, from its midnight) or an ISO-8601 time
with its zone. It writes nothing and no ops line.

### `email:resend`

```bash
npm run cli -- email:resend <emailId> --to-prompt --operator <your operator name>
```

Puts a **failed** row back to pending, due now, its attempts counted from zero, under the address
you type at the prompt. Re-read the address from the row the email is about (the waitlist entry,
the company's party, the guardian's own message), never from a ticket. Without `--yes` it prints
what it would do and writes nothing; run the same line with `--yes` (the prompt asks again). It
writes one ops line, `email_requeued { emailId, operator, operatorOsUser }`.

It refuses a row that is pending (it is on its way) or sent (a sent email is never sent again from
here: section 5 says what to do), an unknown id, and a contact write under any address but the one
it was written for (its consent is that address's).

**The same idempotency key, so never a double send.** The email goes again under its row's own key,
which the provider keeps 24 hours. A failed row may still be one whose send the provider took
(section 4). To the same address, such a send is answered with the first send's id and sent once.
To **a different address within 24 hours of that send**, the provider refuses it (409
`invalid_idempotent_request`): the row fails again, and nothing is sent twice. The fix, after 24
hours: for an invite, a filing or any other email, the same `email:resend`. For an identity link,
`email:send-link --again` the same UTC day (a plain `email:send-link` on a later day): a new key,
so the provider takes it as a new email.

### `email:send-link`

```bash
npm run cli -- email:send-link <tenantId> --url '<the full link>' --to-prompt \
  --operator <your operator name>
```

Queues the beta's identity-check email to a guardian (docs/runbooks/guardian-identity.md, step 2):
subject "Confirm who you are", what is checked, what we keep and what we never keep, the link and
how to copy it, the request for the guardian's legal name exactly as printed on the document they
will use, the request not to attach the document or a photo of it, a link to the privacy page, the
postal address. It names no provider and promises no expiry.

**The replies.** The guardian answers with their name by replying, so the reply goes to
`EMAIL_REPLY_TO`, or to `EMAIL_FROM` where it is not set. That mailbox must be watched before the
first `email:send-link`, and by someone who may read a name. Once `identity:record` is written,
delete the reply and any attachment it came with (a guardian may send the document anyway), from
the inbox and the trash: the record is then the only place the name is kept.

`--url` is the full link you built; it must be https, and it must carry neither the person's
address (a `prefilled_email` parameter, or the address anywhere in the link, escaped or not, is
refused: the guardian types their address in the check) nor the account id (the tenant, with or
without its 0x, in any case) nor any other wallet address (`0x` and 40 hex characters, anyone's,
escaped or not): the link carries the opaque reference. `<tenantId>` is the
guardian's wallet address in any case; anything else is refused.

One link per guardian per UTC day (the idempotency key is `identity_link:`, a digest of the tenant
and the day): a second the same day writes nothing and prints the first one's id and state. When
the day's latest link failed or was not delivered, add `--again` for a new one the same day
(section 5, `identity_link`); its output and its ops line name the row it `replaces`.
Without `--yes` it prints the email it would queue (subject, key, link) and writes nothing. It
writes one ops line, `identity_link_queued { emailId, tenant, operator, operatorOsUser }`, the
tenant cut to its first ten characters.

## 7. Staging: following the links

The staging instance runs the console sender: no email leaves, and each one is an `email_console`
line with its subject and key. To click the links an email holds (the waitlist confirmation, an
invite, an identity link), set `EMAIL_CONSOLE_SHOW_BODY=true` on the staging instance: each line
then carries the text body, the recipient's address printed as `<recipient>`. It is refused with
the provider sender: a box with `EMAIL_PROVIDER=resend` refuses to boot with it, on any
deployment, and so does an http `PUBLIC_APP_URL` there. The staging proof, the console sender in
production mode (`ARC_NETWORK=mainnet`), may set it and may build its links on
`http://localhost`.

## 8. The marketing segment, and contacts from before it

A consenting address becomes one `contact_upsert` row, keyed by a digest of the address, which
writes the address into `RESEND_MARKETING_SEGMENT_ID`'s segment. **Without that setting, the
sender skips the write**: the row ends `sent` with `providerMessageId` `skipped`, and a
`contact_upsert_skipped` line. The consent itself stays proven in our own tables.

Its key is used: a later consent from the same address writes nothing. So once a segment is
configured, the contacts from before it are **backfilled from the waitlist table** (its confirmed
entries, whose consent it records): a one-off import into the segment, never by re-running the
skipped rows.
