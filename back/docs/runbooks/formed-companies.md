# Runbook: formed legal-body companies

Four operator commands cover what doola does by hand for a company Novi formed for a legal body,
or what its API cannot settle (`src/cli/formedCompanies.ts`):

- `company:filed-name` and `company:dao-supplement`, on a company the State has filed;
- `formation:record-filed` and `formation:record-ein`, the assisted completion of a paid company
  whose filing doola did by hand, outside its API.

Every command below runs on the box, from the backend directory:

```bash
npm run cli -- company:filed-name <companyId> --name "<name>" --operator <name>
```

## 1. What a formed legal-body company is

A company row with `provider = doola` and `purpose_kind = legal_body`. The order door, the link
door and the resolver take it (`companyEligible`, `src/legalBody/orders.ts`) once:

- the State's filing is confirmed (the `await_filing` step is `confirmed`);
- the row holds both the filed name (`legal_name_filed`) and the filing number (`filing_number`):
  the agreement prints both;
- its latest company check is not a revocation;
- the company is not `abandoned`.

Creating one (`POST /companies` with `for: "legal_body"`) runs the formed door's gates first, in
this order: a real human (a waiver is refused), the per-human company cap, the guardian identity
record and the approved operating agreement (these two on production only). Production then
refuses (`formed_door_not_offered`, 403) until the invite codes ship. The door runs under
production when doola's pin or the network is production. On production, the formed door also
stops at its lifetime cap, `FORMATION_MAX_TOTAL` (`formation_cap_reached`, 409; see "Spend
controls" in `doola-deploy.md`).

## 2. company:filed-name

Sets the company's filed name, its full legal name as the State's record prints it.

**When to run it.**

- doola reported a name that matched none of the stored options. The processor then stores no
  filed name, and the order door refuses the company (`company_not_eligible`).
- The stored name differs from the State's record.

**Copy the name exactly as the State's record prints it, with its entity ending.** It is stored
as typed, never cleaned. It is held to the agreement's company-name rule: a name the rule refuses
is refused with the rule's reason, and a name the rule would change (a space at an end, a run of
spaces, a character NFC rewrites) is refused too. A later poll of doola never rewrites a name the
company holds.

**A first set.** Refused if the company already has any legal-body order: the order door never
writes one without a filed name, so find out how it happened first.

**`--replace`** corrects a name the company already holds. It is refused:

- when the new name is the one held;
- while an order is open (a draft within its 24 hours, a reserved or a deployed order);
- while a legal body is linked, or was and can be again (linked, broken, superseded);
- for a legal body in a state this build does not know.

Why: an agreement is never signed with a superseded name, and a linked body's statement must not
state a name its frozen agreement does not print. A draft's guardian can abandon it, or it expires
24 hours after it was ordered; then `--replace` goes through. An abandoned or lapsed order holds
nothing. A change of legal name after linking is a matter for counsel, not for this command.

**Warnings.** None of them refuses: the State's record is the truth. They appear under `warnings`
in the dry run and the real run alike.

| Warning starts with | What to do |
| --- | --- |
| `matches no stored option` | Check the name against the State's record once more. |
| `no entity ending` | The State's record of an LLC carries its ending. Check the name; correct it with `--replace` while no agreement prints it. |
| `the company has no filing number` | The order door needs both the name and the number, so the company cannot be ordered yet. For a company doola filed through the API, the next poll fills the number once doola reports it. For a filing done by hand, `formation:record-filed` records it (section 5). |

**What it writes.** The filed name, a note (`filed_name_recorded`) on every legal body of the
company, and one ops line `filed_name_recorded` with the company id, `matched`, `replaced`, the
operator and the OS user. Never the name.

## 3. company:dao-supplement

```bash
npm run cli -- company:dao-supplement <companyId> --document <path.pdf> --operator <name>
```

Records doola's amended articles (the supplement to the company's articles that doola files by
hand) as an operator document of the company, in one transaction:

- a row in the document index (`doc_type = dao_supplement`, `source = operator`, the file's
  SHA-256);
- a note (`dao_supplement_recorded`) on every legal body of the company;
- the file in the document store, written last, so a failure leaves no row, no note and no file.

The company view shows the latest one recorded: when it was recorded and its hash. It is recorded,
never claimed: nothing calls the company a DAO from it. One ops line `dao_supplement_recorded`
carries the company id, the document id, the operator and the OS user. Never a path or a byte of
the file.

**The file.** A file, not empty, at most 10 MiB (10,485,760 bytes; exactly 10 MiB is taken), whose
bytes start with `%PDF-`. Nothing else in it is read. A refusal never names the path: a file that
cannot be read is refused with its error code (`ENOENT` and the like).

**`--replace`.** A second supplement is refused without it. With it, the index keeps both rows and
the view shows the latest.

**The same file twice is refused**, with `--replace` too: the index keeps one row per file.

**There is no way yet to make an earlier supplement the latest again**: recording its file a
second time is the same file, so it is refused. Check the file before `--replace`.

## 4. company:filed-name and company:dao-supplement

- **`--yes`** runs it for real. Without it, the command is a dry run: it prints what it would
  write (`recorded: false`, and `next`) and writes nothing, not even an ops line.
- **`--operator <name>`** is who runs it, matching `^[a-z0-9._-]{2,40}$`. `system` is reserved
  for what the platform records by itself and is refused.
- Each prints one JSON object on success. A refusal starts with `refusing:` and exits non-zero.
  The rules and the write run in one immediate transaction.

**The company refusals**, in the order they are checked:

| Refusal | Meaning |
| --- | --- |
| `no company <id>` | No such company. |
| `company <id> was not formed through doola (provider ...)` | These commands take only a company Novi formed through doola, never a customer's own. |
| `company <id> was formed for agents, not for a legal body` | A company formed for agents never stands behind a legal body. |
| `company <id> is abandoned: nothing can be recorded on it` | The company is abandoned. |
| `the State's filing of company <id> is not confirmed yet (await_filing is ...)` | Wait for the filing. |

`company:dao-supplement` checks the company before the file, so a wrong company id is refused as
such, whatever `--document` names.

## 5. formation:record-filed

```bash
npm run cli -- formation:record-filed <companyId> --filing-number <n> --filed-at <YYYY-MM-DD> \
  --legal-name "<as the State's record prints it>" --articles <path.pdf> --operator <name> --yes
```

Records the filing of a paid formed company that doola did by hand, outside its API (doola's amended
articles, a filing made through doola's portal, an API outage). It writes the rows the saga writes for an API
filing, with one difference: the provider ref is `manual:<operator>`. That ref names no company at
doola, so the saga never polls, retries or abandons the company afterwards.

**When to run it.** doola tells you it filed the company by hand and sends the Articles of
Organization. Copy every value from the State's record, not from an email.

**What it checks**, before the file is read and again inside the transaction:

- the company is formed through doola for a legal body and is not abandoned (the refusals of
  section 4);
- the company is paid (`status = ready`);
- its formation party is bound to it and not erased;
- its formation rows: none at all, or `create_provider` `pending` or `failed` with no provider ref
  and the three later steps `pending`.

| Refusal | Meaning |
| --- | --- |
| `company <id> is not paid (status draft): only a paid company is filed` | Nothing was settled for it. |
| `company <id> has no formation party: ...` | A paid company always has one. Find out why first. |
| `a create is being sent to doola: wait for it` | The saga is sending the create now. Run the command again in a few minutes. |
| `the API filed this company: nothing to record` | `create_provider` is confirmed: the API created it at doola, and the saga follows it. |
| `doola holds a company for company <id> (create_provider has a provider ref): ...` | A create returned a company id. The saga adopts it. |
| `a create went out to doola for company <id> and its answer was lost: doola may hold the company. ...` | A create was sent under a key that is still live and its answer never came back (an outage), or the row's detail cannot be read. Ask doola whether it holds a company for this company's customer. If it does, do not record: the saga's next retry re-sends the same key and doola answers with that company, or its lookup by the customer finds it, and the saga adopts it. If doola confirms it holds none, run again with `--doola-confirmed-no-company`; the ops line then carries `frozenCreate: true`. Record soon after: until the record lands, the saga keeps retrying that create. |
| `the filing of company <id> is already recorded by <operator>` | A record exists. Nothing is written twice. |
| `the <step> step of company <id> is <state>, not pending: ...` | A shape no filing leaves. Tell the backend owner. |

**The values**, each refused, never cleaned:

- `--filing-number`: the agreement's filing-number rule (4 to 32 of A-Z, a-z, 0-9 and hyphens). A
  space at an end is refused.
- `--filed-at`: a real calendar date written `YYYY-MM-DD` (2026-02-30 is refused), not before
  1970-01-01 and not after today's date in UTC. It is stored as unix seconds at UTC midnight, as
  the processor stores doola's filing date. A date before the day the company was created at
  Novi is written, with the warning `the filing date is before the company was created at Novi`:
  doola may file before Novi's row exists, but check it against the State's record.
- `--legal-name`: the full legal name, stored exactly as typed. It is held to the company-name
  rule of `company:filed-name`, with the same two warnings (`matches no stored option`,
  `no entity ending`). Neither refuses: the State's record is the truth.
- `--articles`: a PDF of at most 10 MiB, held to the rules of `company:dao-supplement`'s
  `--document`. A refusal never names the path.

**What it writes**, in one transaction, the file last:

| Row | An API filing (the processor) | `formation:record-filed` |
| --- | --- | --- |
| `create_provider` | `confirmed`, ref = doola's company id | `confirmed`, ref = `manual:<operator>`, detail `{ recordedBy, recordedAt }` |
| `await_filing` | `confirmed`, detail with doola's `filingNumber` and `filingDate` | `confirmed`, detail `{ filingNumber, filingDate, filedAt, recordedBy }` |
| `fetch_documents` | `confirmed` once the Articles and the operating agreement are stored | `confirmed`, detail `{ recordedBy, docIds }`: the Articles are the documents |
| `await_ein` | `pending`, polled | `pending`, ref = `manual:<operator>`, never polled |
| `companies` | `filed_at`, `filing_number`, `legal_name_filed`; `status` stays `ready` | the same three, from the command's values; `status` stays `ready` |
| `documents` | doola's documents, `source = provider` | the Articles, `doc_type = ArticlesOfOrganization`, `source = operator` |
| event `formationFiled` | on every attached entity | the same; a legal-body company has none |
| the party's SSN | erased (`provider_persisted`) when doola's company id lands | erased the same way, in the same transaction |

A test files one company through the sandbox and the processor and records another with the same
name, number and date, and compares these rows (`test/cli/recordFiled.test.ts`). The order door
takes both alike, and both agreements print the same name and number.

**Output.** One JSON object: the recorded values, `matched`, any `warnings`, the document's id,
hash and size, and `next: "formation:record-ein when the IRS letter arrives"`. One ops line
`formation_recorded_filed` carries the company id, `matched`, `frozenCreate: true` when
`--doola-confirmed-no-company` let it through, the operator and the OS user. Never the name, the
number or the path. When the party held an SSN, the erasure's own line `formation_ssn_erased`
(company, reason, environment) comes before it.

**Afterwards.** Nothing asks doola about the company: the saga skips it, and its compliance page
answers at once with no events and `recordedByHand: true` (the annual-report placeholder stays).
The operator's handle in the `manual:` ref is internal: every view serves the provider ref as
null.

No email is sent yet. The filing email for this path comes in a later change.

## 6. formation:record-ein

```bash
npm run cli -- formation:record-ein <companyId> [--ein <NN-NNNNNNN>] --operator <name> --yes
```

Confirms the EIN step of a company `formation:record-filed` recorded, when the IRS letter arrives.

**Until then**, the company's `await_ein` row stays `pending` and is never polled. The sweeper
warns about it as stale (`formation_stale`) once the row is 14 days old (`FORMATION_STALE_MS`), and
again each day until this command confirms it. The IRS takes four to six weeks, so expect the
warning.

**What it checks.** The company checks of section 5, then the `await_ein` row: `pending` under a
`manual:` ref.

| Refusal | Meaning |
| --- | --- |
| `the API tracks this company's EIN: nothing to record` | doola filed it through the API. The processor reads the EIN. |
| `company <id> has no filing recorded by hand: ...` | Run `formation:record-filed` first. |
| `company <id> already holds an EIN: nothing to record` | An EIN is stored. A second one is refused, whatever its value. |
| `the EIN step of company <id> is already recorded (await_ein is confirmed): pass --ein to store the EIN it lacks` | The step was confirmed without a value. Run again with `--ein` to store it. |
| `--ein must be written NN-NNNNNNN: ...` | Two digits, a hyphen and seven digits. |

**What it writes**, in one transaction:

- `await_ein` `confirmed`, detail `{ recordedBy, observedAt }`;
- with `--ein`, the EIN on the company (`companies.ein`), as the processor stores one. Without it,
  the step is confirmed and no value is stored. A later run with `--ein` stores it, once: only the
  EIN is written, and the step stays as the first run confirmed it;
- the `formationEin` event, as the processor writes it, without the EIN.

A legal body's statement for the company then reads `einIssued: true`. The output and the ops line
`formation_recorded_ein` carry the company id, `withValue` (whether an EIN was stored), the
operator and the OS user. Never the EIN.

Both commands follow the rules of section 4: `--yes` for the real write (a dry run without it
writes nothing, not even an ops line), `--operator` matching `^[a-z0-9._-]{2,40}$` (`system` is
refused), one JSON object, and a refusal that starts with `refusing:`.
