# Runbook: formed legal-body companies

Two operator commands cover what doola does by hand for a company Novi formed for a legal body,
or what its API cannot settle: `company:filed-name` and `company:dao-supplement`
(`src/cli/formedCompanies.ts`).

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

Production refuses to create one (`formed_door_not_offered`, 403) until the formed door's gates
ship.

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
| `the company has no filing number` | The order door needs both the name and the number, so the company cannot be ordered yet. This build has no command that sets the number: tell the backend owner. |

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

## 4. Both commands

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
