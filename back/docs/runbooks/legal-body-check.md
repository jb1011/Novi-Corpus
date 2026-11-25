# Runbook — the legal-body check

A seller on World's AgentKit can ask whether a verified unique human vouches for the address
about to pay it; this ships the second question, "does a registered legal body stand behind
that address, and does Novi state its standing as active?", as a public lookup, a
seller policy and a demo (design 2026-09-10, D1–D8). The configured seller is untouched: the wall pins its own.

## The public lookup

`GET /legal-bodies/:address` is mounted on the API app at the root, beside `/transparency` (`api/app.ts` →
`mountLegalBodyRoutes`), so it answers wherever the API answers. Two hosts reach it.
`https://api.novicorpus.com/legal-bodies/<address>` is the box directly, and the URL the code hands out wherever
`PUBLIC_API_URL` is set (`main.ts` composes `how.lookup` from `cfg.publicApiUrl ?? cfg.metadataBaseUrl`) — use it for
anything that reads headers, caches or runs in a browser. `https://www.novicorpus.com/backend/legal-bodies/<address>`,
the Vercel proxy other public surfaces use, forwards allowlists only (`interface/src/lib/proxyHeaders.ts`): no CORS
header (a browser-side seller gets a CORS error, not an answer), no `Cache-Control`, and no `X-NOVI-LEGAL-BODY` until
the interface at HEAD is deployed. `links.metadata` stays on `METADATA_BASE_URL` either way.

**A known active body** — agent 843704 (TestMB2), the first Novi legal body registered in AgentBook (2026-09-09). An
address we have no entity for answers 200 with four keys and nothing else, echoed EIP-55-checksummed; a bad one
answers 400 (all-lowercase or EIP-55 only, viem `isAddress(a, {strict:true})`, never silently re-cased).

```bash
curl -s https://api.novicorpus.com/legal-bodies/0xeE85Fd00521d1Aa4c510BDdAb78F375830119354
# {"address":"0xeE85Fd00521d1Aa4c510BDdAb78F375830119354","legalBody":true,"standing":"active",
#  "agentId":"843704","publicId":null,"name":"TestMB2","network":"testnet","links":{"transparency":
#  "https://www.novicorpus.com/transparency","metadata":null},"formation":null,"checkedAt":"…"}
curl -s https://api.novicorpus.com/legal-bodies/0x000000000000000000000000000000000000dead
# {"address":"0x000000000000000000000000000000000000dEaD","legalBody":false,"standing":null,"checkedAt":"…"}
curl -s https://api.novicorpus.com/legal-bodies/0xnope
# {"error":"validation_error","message":"address must be a 20-byte hex address, either all-lowercase or EIP-55 checksummed"}
```

**Every field of the 200 for a body**: `address` (echoed EIP-55), `legalBody`, `standing`, `agentId` (a decimal STRING
— a uint256 token id), `publicId`, `name`, `network`, `links` (`transparency`, plus `metadata` =
`<METADATA_BASE_URL>/metadata/<publicId>`, null when the row has no `publicId`, as above), `formation`, `checkedAt`,
and nothing else. `formation` is null when the entity has no company and otherwise carries FOUR fields — `filed`,
`einIssued`, `status`, `environment` (`sandbox` beside the status on purpose, so a sandbox filing can never read as a
Wyoming company) — never the EIN, never the filing number. `standing` is what the chain says at that moment: `active`
only when `legalStatus == 0` and the treasury is not paused, `inactive` on a definitive negative, `unknown` when the
read failed — never guessed, never memoised.

**Throttling, freshness, 503, 404.** Two token buckets, both spent on a memo MISS only (a hit reads no chain): a
per-client `TokenBucket(10, 0.5)` keyed by the LAST `X-Forwarded-For` entry, the one the proxy in front of the API
appended (`"direct"` if none; 2000 keys), in front of one process-wide `TokenBucket(30, 1)`. Either refuses identically —
`{"error":"rate_limited","message":"try again in a few seconds"}`, 429 — so a caller never learns which, and one ops
line per 60 s names it. A definitive 200 carries `Cache-Control: public, max-age=15`, matching the 15-second
per-address memo; `standing: "unknown"`, the 400, the 429 and the 503 carry `no-store`. The 503 —
`{"error":"unavailable","message":"could not check right now; try again shortly"}` — comes only from the local
database read; every chain failure is `unknown`, not a throw. A deployment with NO resolver wired never mounts the
route, so it answers 404 — a fourth non-200, read as `null` by the checker like the other three.

**A Minimal legal body** (one the legal-body factory created for an ERC-8004 agent whose owner brought an existing
Wyoming LLC). The branch exists only where the legal-body feature is on (`LEGAL_BODY_FACTORY_ADDRESS` and
`CONTROLLER_ADDRESS`) AND `NOVI_ATTESTATION_KEY` is set: `main.ts` builds `legalBodyStatements` from those. Without it
the address route answers exactly as above and `GET /legal-bodies/by-agent/:agentId` is a 404. It is asked only for an
address the full-product resolver does not know, so every full-product answer is unchanged. Its candidates are the
agents whose legal-body rows record the address as the identity owner, then those whose logged statements record it
as the agent's wallet (at most 5); one snapshot reads their wallets, and only an agent whose `getAgentWallet` is that
address, read fresh and again at the statement's own block, gets a statement (the first 3 confirmed; an `active` one
is preferred). The answer then carries the signed statement (`docs/identity/legal-body-statement.md`): `standing` may
also be `pending`, `name` is the statement's `legalName` (empty until it may be shown), `links.metadata` and
`formation` are null, and `links.statement` is the by-agent URL. A signed statement is memoised and served
`public, max-age=15` whatever its standing, a signed `unknown` included. A chain failure answers `unknown` with
`statement: null` and `agentId: null`: `no-store`, never memoised, no statement-log row. It can rest on candidates the
chain could not confirm, so it is not a yes. The 503 still means the local database. The by-agent route has its own
15-second memo, and shares both token buckets: one token from each per miss, however many reads the miss makes. Its
400 is
`{"error":"validation_error","message":"agentId must be a decimal token id of at most 78 digits, without leading zeros"}`.
A wallet that is not the identity owner is found by address only after a by-agent miss has logged it, and after the
address's own 15-second memo of `legalBody: false` has passed.

```bash
curl -s https://api.novicorpus.com/legal-bodies/by-agent/<agentId> | jq '.legalBody, .standing, .statement.message.bindingState'
```

## The agent's own wallet at the link

A legal body is created only for an agent whose identity names a wallet of its own: the wallet the identity
registry answers for `getAgentWallet` must be set, and it must not be the guardian's wallet. A guardian who registered
the identity from their own wallet leaves that wallet named as the agent's, so the link waits until the identity's
owner sets the agent's wallet with `setAgentWallet` and that wallet's signature.

The refusal code is `agent_wallet_required`. The link message door (`POST /legal-body-orders/:id/link-message`)
answers it as a 409, and the MCP tool `get_link_message` passes the same code and sentence through; the submit
(`POST /legal-body-orders/:id/link`, and `submit_link`) answers `status: "refused"` with that code and a `detail`
naming the identity's owner and the wallet it read. Nothing is written either way: the order stays a draft. What an
operator answers: the guardian sets the agent's wallet from the website's step "Your agent's wallet", which shows
before the link; for a legal body that already exists, from its done page, the card "Set your agent's wallet". The
rule is at the link only: it does not touch a legal body created before it.

To read the wallet an identity names (here on Arc testnet, with the public RPC):

```bash
cast call 0x8004A818BFB912233c491871b3d84c89A494BD9e "getAgentWallet(uint256)(address)" <agentId> \
  --rpc-url https://rpc.testnet.arc.io
# the zero address, or the guardian's own address: the link answers agent_wallet_required
# any other address: the agent has a wallet of its own
```

## The company's pot

**What the `pot` block says.** The guardian of a linked legal body may create the company's pot: a Safe
(v1.4.1) whose only owner is the guardian, with Safe's AllowanceModule (v0.1.1) letting the agent's own key take USDC
from it up to a ceiling in each thirty-day period. The guardian's wallet signs and sends every transaction from the
web app; Novi Corpus holds no key to the Safe or to the agent's key, holds none of the money, and only notes the
Safe's address and reads the Safe from the chain. The `pot` block of a lookup is what that read found, at the
statement's own block: it sits beside the signed statement, outside it, and is not signed.

It is served by `GET /legal-bodies/by-agent/<agentId>` and by `GET /legal-bodies/<agent's wallet>` (the body's pot on
the record), and `GET /legal-bodies/<pot address>` answers the same legal body for any pot that body declared once
that address holds a pot's code (an address noted and never created leads nowhere; the ops line says
`"matchedBy":"pot"`). Its states:

- `ceiling_read`: the ceiling (`ceilingUnits`), what was taken in the current period (`spentUnits`), the period's
  end (`periodEndsAt`, unix seconds), what the pot holds (`balanceUnits`), `readAtBlock`, `readAt`, `declaredAt`
  and `birth`. Units are USDC's 6 decimals, as decimal strings.
- `stopped`: the allowance is switched off (the module is off, or the agent's key is no longer listed); what it holds.
- `limits_not_read`: a pot of the guardian's alone with something the rules do not read past (another add-on, a
  guard, another fallback handler, an approval to the agent's key, another key, another token, another period), or
  any pot while the pot is switched off on this deployment (below). No amount.
- `former`: a pot the body declared that is no longer the one on the record (taken off it, or replaced by a later
  note), with `declaredAt` and `endedAt`. Served only by a lookup by that pot's own address, which still leads to the
  body.
- `unavailable`: the chain could not be read just now. No claim at all, never memoised.

`pot` is null when no pot is on the record (none noted, or taken off), when the noted address holds no code yet,
when the Safe is not the guardian's alone (another owner, another threshold, other code), and beside a statement not
in force.

**The periods are fixed.** Each thirty-day period starts where the last one ended, counted from the minute the
ceiling was first set (the module's `lastResetMin`); what was not taken does not carry over. So the agent's key can
take the whole ceiling in the last minutes of one period and the whole ceiling again at the start of the next: twice
the ceiling within a few minutes is possible around a period's end. A change of the ceiling keeps the current period
and what was taken in it; "Start again" and a new key start a new period at the minute they are mined.

**The reading rules**, in this order, the first that applies decides (`potReading` in
`back/backend/src/legalBody/safePot.ts`; the website holds the same list):

1. No code at the address: `absent` (the record serves nothing).
2. The code is not a Safe proxy's, or its singleton is not SafeL2 v1.4.1, or its owners are not exactly the
   guardian, or its threshold is not 1: `not_the_guardians` (the record serves nothing).
3. Its modules are neither none nor exactly the AllowanceModule, or the list goes on: `limits_not_read`
   (`other_module`).
4. A guard is set: `limits_not_read` (`guard_set`).
5. The fallback handler is not Safe's CompatibilityFallbackHandler v1.4.1: `limits_not_read` (`other_handler`).
6. The pot has approved the agent's key on USDC: `limits_not_read` (`usdc_approved`).
7. No module: `stopped` (`module_off`).
8. No delegate, and the list ends there: `stopped` (`no_delegate`).
9. The delegates are not exactly the agent's wallet, or the list goes on, or the agent's wallet is the guardian's:
   `limits_not_read` (`other_delegate`).
10. The key's tokens are not exactly USDC: `limits_not_read` (`other_token`). This also closes an allowance on the
    native coin.
11. The period is not 43,200 minutes: `limits_not_read` (`other_period`).
12. Any of the allowance's five fields is not a number: `limits_not_read` (`other_period`). Otherwise
    `ceiling_read`.

The module's own answers are never enough: after `disableModule` it still answers the key and a live-looking
allowance, and after `removeDelegate` it still lists the token. Rules 3 and 7 read the Safe's own module list first
for that reason. The rules are applied only to an address the server recomputed itself from the birth details.

**Recomputing a pot's address from `birth`, without trusting Novi Corpus.** `birth` gives the guardian, the agent's
wallet it was set up for (its first key), the token, the first ceiling in units, the period (43,200), the salt
number, and the five contracts. The initializer is
`setup([guardian], 1, multiSendCallOnly, multiSend(enableModule(allowanceModule) to the zero address, addDelegate(agentWallet), setAllowance(agentWallet, token, ceilingUnits, 43200, 0)), fallbackHandler, 0x0, 0, 0x0)`,
each part of the batch packed as operation 0 (uint8), to (address), value 0 (uint256), the data's length (uint256)
and the data. The salt is keccak256 of keccak256(initializer) followed by the salt number as 32 bytes. The address is
CREATE2 of `proxyFactory` with that salt and keccak256 of the factory's `proxyCreationCode()` followed by `singleton`
as a 32-byte word. With `cast` alone (these values are vector V3, whose address is
`0x4A13bC20E8596009CA37B897Aaf654C5e0b8e87D`; put the `birth` values in their place):

```bash
GUARDIAN=0x15D4EE6F84b6bf8ceE5A24cCb19FDF8257c22b0A AGENT=0x2dDcf8da463526614b9FA5E87Db259a3Bf06667C
TOKEN=0x3600000000000000000000000000000000000000 CEILING=50000000 SALT=1
FACTORY=0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67 SINGLETON=0x29fcB43b46531BcA003ddC8FCB67FFE91900C762
HANDLER=0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99 MULTISEND=0xA83c336B20401Af773B6219BA5027174338D1836
MODULE=0xAA46724893dedD72658219405185Fb0Fc91e091C RPC=https://rpc.testnet.arc.io
ZERO=0x0000000000000000000000000000000000000000
part() { local data=$(cast calldata "$2" "${@:3}"); cast abi-encode --packed "f(uint8,address,uint256,uint256,bytes)" 0 "$1" 0 $(( (${#data} - 2) / 2 )) "$data"; }
BATCH=$(cast calldata "multiSend(bytes)" $(cast concat-hex \
  $(part $ZERO "enableModule(address)" $MODULE) \
  $(part $MODULE "addDelegate(address)" $AGENT) \
  $(part $MODULE "setAllowance(address,address,uint96,uint16,uint32)" $AGENT $TOKEN $CEILING 43200 0)))
INIT=$(cast calldata "setup(address[],uint256,address,bytes,address,address,uint256,address)" \
  "[$GUARDIAN]" 1 $MULTISEND $BATCH $HANDLER $ZERO 0 $ZERO)
SALTHASH=$(cast keccak $(cast concat-hex $(cast keccak $INIT) $(cast to-uint256 $SALT)))
INITCODEHASH=$(cast keccak $(cast concat-hex $(cast call $FACTORY "proxyCreationCode()(bytes)" --rpc-url $RPC) \
  $(cast abi-encode "f(address)" $SINGLETON)))
cast compute-address $FACTORY --salt $SALTHASH --init-code-hash $INITCODEHASH
# Computed Address: 0x4A13bC20E8596009CA37B897Aaf654C5e0b8e87D
# INITCODEHASH is 0xe298282cefe913ab5d282047161268a8222e4bd4ed106300c547894bbefd31ee on Arc testnet and mainnet
```

**The read for an operator** (run on 24 Nov against the real Safe of the testnet run): the five numbers are the
ceiling, what was taken in the current period, the period in minutes, the minute the period started, and a counter.
The module answers them even when the Safe has switched it off, so read the Safe's modules too
(`getModulesPaginated(0x0000000000000000000000000000000000000001,10)`).

```bash
cast call 0xAA46724893dedD72658219405185Fb0Fc91e091C "getTokenAllowance(address,address,address)(uint256[5])" \
  <pot> <agent wallet> 0x3600000000000000000000000000000000000000 --rpc-url <rpc>
```

**The start-up check, and the pot's switch.** At boot the server reads the code of the seven contracts the pot is
built from (SafeL2, the proxy factory, the fallback handler, MultiSendCallOnly v1.5.0, the AllowanceModule,
Multicall3, and USDC's proxy) and compares keccak256 of each with the pinned hash. It never stops the server: it is
started and not awaited, so legal bodies, formation and everything else run whatever it finds, and only the pot is
switched on or off. The boot log says which:

- `[boot] pot contracts verified on-chain: 7 code hashes on chain <id>`: the pot is offered,
  `/config.legalBodies.pot` is `true`.
- `[boot] pot contracts NOT verified: unreadable: ...`: a node could not be read. The pot is off, and the check is
  tried again once a minute; it turns on by itself once the seven hashes verify (the verified line follows).
- `[boot] pot contracts NOT verified: mismatch: ...`: a contract holds no code or other code (the line names it, its
  address and both hashes). The pot stays off until a restart. Investigate first: a restart only checks again.

While the pot is off: `/config.legalBodies.pot` is `false` and the website offers no pot and no action on one, apart
from a card to take a pot that is on the record off it; the note door
and the agent's two MCP tools answer 409 `pot_not_offered`; the guardian's read of the body's notes
(`GET /legal-body-orders/:id/pot`) and the take-off door still answer, so a pot on the record can always be taken
off it; and the record still names a pot that holds a pot's code, with "Its limits were not read." and no amount.

**The doors and their refusal codes.** The sentences are in `back/backend/src/legalBody/sentences.ts`.

- `POST /legal-body-orders/:id/pot`, the note, before the setup transaction (after the real-human check and the
  doors' throttle): 409 `pot_not_offered`; 404 `not_found`; 409 `order_closed`, `legal_body_revoked`,
  `other_deployment`; 400 `pot_invalid`, `pot_declaration_required`; 409 `pot_chain_unsupported`,
  `grant_allows_no_spending`, `ceiling_above_grant`, `pot_address_mismatch` (also a first key that is not the
  registry's), `pot_taken` (another legal body noted this address), `pot_exists` (one pot for life: another noted
  pot of this body holds code), `pot_pending` (a pot noted earlier is still being set up: it is finished at its own
  address), `agent_wallet_required`; 503 `chain_unavailable`; 429 `rate_limited`.
- `GET /legal-body-orders/:id/pot`: 404 `not_found`; otherwise `{ "pot": null }` or the latest note.
- `POST /legal-body-orders/:id/pot/off-record`: 404 `not_found`; 409 `pot_not_on_record`. Any state, any deployment,
  whatever the switch: a guardian may always take a claim back. The pot itself, its money and its allowance are
  untouched.
- MCP `get_pot` and `prepare_pot_take`: 409 `pot_not_offered`; 404 `not_found`; 409 `pot_not_declared`; 400
  `pot_take_invalid`; 409 `pot_take_body_not_in_force`, `pot_chain_unsupported`, `pot_take_bad_payee`,
  `pot_not_readable` (the reading is not `ceiling_read`), `pot_take_over_ceiling`, `pot_take_over_balance`; 500
  `internal_error` (a note whose birth details do not give its address); 503 `chain_unavailable`. `get_pot` is a
  read and answers for a body in any state; a take is prepared only for a body in force. The prepared take is sent by
  the agent's key itself, to the AllowanceModule, with an empty signature and a gas limit of 200,000.

**One action at a time on the card.** While any wallet action or record action of the pot's card is in flight, every
other button of the card is disabled. A wallet prompt that never answers holds that lock until the prompt settles
(the person approves or rejects it in the wallet) or the page is reloaded: tell a guardian whose buttons stay grey to
look for an open prompt in the wallet, then reload.

**Wording rules of the record.** Never "enforced", "guarantee" or "guaranteed" about the pot: the ceiling is "read
from the chain". Every sentence about the pot's ceiling says "in each thirty-day period" (or "the current period"),
never "per thirty days", which stays for a grant's own amounts. The stopped sentence is exactly "The agent's key
cannot take from it: its allowance is switched off." and never more: no read can show that no key at all can move
the pot's money.

**What to watch.** `legal_body_pot_declared` and `legal_body_pot_removed` (`{"legalBodyId"}`), one per note;
`legal_body_pot_unavailable` (`{"legalBodyId","errorName"}`), a chain read of the record failed;
`legal_body_pot_note_unrecomputable` (level error, `{"legalBodyId"}`), a note whose birth details do not give its
address, never served: worth an alarm; `legal_body_chain_unavailable` with a `stage` of `pot_code`,
`pot_agent_wallet` or `pot_read`, the 503 of a door or a tool.

## The seller policy

`X402_TRUST_POLICY=legal-bodies-only` (third value, `config/env.ts`) applies to the deployment's configured wall at
`/x402-demo/quote`. It requires, in order: an `agentkit` config AND a resolver wired — either one missing and EVERY
request is refused 503, ahead of the no-proof 403 (`accountable-only` still degrades to `open` without it —
pre-existing); an `agentkit` header; a valid proof of a verified unique human (that AgentBook answer is memoised 1 h
positive / 60 s negative, as under `accountable-only`, so a REVOKED vouch can clear this first gate for up to an
hour); then `resolveLegalBody()` on the PROOF'S SIGNER, read fresh every time, never anything the caller asserted,
returning a public-on-chain Novi entity — matched by pocket or treasury — whose `legalStatus == 0` and treasury is not
paused. The four refusal bodies, verbatim (`payments/seller.ts`):

- **403** no proof, an invalid proof or no human — unchanged from `accountable-only` (`reason` is then the
  verifier's own):
  `{"error":"human_backing_required","detail":"this seller trades only with agents a verified unique human answers for","reason":"no-proof-presented","how":{"register":"npx @worldcoin/agentkit-cli register <your-agent-address>","agentBook":"<configured AgentBook address>","chain":"world-chain"},"extensions":{…}}`
- **429** the per-human budget, unchanged: `{"error":"rate-capped","detail":"per-human request budget exhausted for this window"}`, with `X-AGENTKIT-HUMAN` set.
- **403** human-backed, no legal body:
  `{"error":"legal_body_required","detail":"this seller trades only with agents that a registered legal body stands behind, one whose standing Novi states as active","reason":"not-legal-body","how":{"lookup":"https://api.novicorpus.com/legal-bodies/<checked address>","onboard":"https://www.novicorpus.com/","transparency":"https://www.novicorpus.com/transparency"},"extensions":{…}}`
  — `reason` is `legal-body-inactive` for a suspended body; everything else is identical, and
  `how.lookup` is `<PUBLIC_API_URL or METADATA_BASE_URL>/legal-bodies/<the proof's signer>`.
- **503** the check could not be MADE (fail closed, nothing remembered):
  `{"error":"legal_body_check_unavailable","detail":"the legal-body check could not be completed just now"}` — and
  with no resolver or no `agentkit` config: `"detail":"this seller's legal-body check is not configured right now"`.

**The per-human meter: one unit per purchase, one per refusal, zero on a 503.** Exhaustion is checked BEFORE any chain
read (the 429 above), and the unit is spent once the legal answer is DEFINITIVE. The 402 a passing check leads to is
charged; the paid request that follows is exempt ONLY because it is SERVED — that skip needs a payment we can verify
locally (recipient, amount, expiry, signature, unspent nonce) AND a settlement that succeeds. Everything else charges:
both legal 403s whatever rode along, and a payment that fails to settle; only the 503 charges nothing, so
`X-AGENTKIT-AUTHORIZATION` is absent from it. Each issued 402 buys exactly ONE paid attempt: past that a
payment-carrying request is refused 429 before the facilitator and before the Arc reads, capping settle attempts per
human per window at the allowance. `accountable-only` gets that bound and one unit per PURCHASE, refusals unchanged.

Served: `X-AGENTKIT-HUMAN`, `X-AGENTKIT-AUTHORIZATION: <used>/<limit>` and `X-NOVI-LEGAL-BODY: <agentId>` (omitted,
never blank, when the record has no agent id) — all three already on the 402 invoice a passing check leads to. The 200
body adds `humanBacked: true` and `legalBody: {"agentId": …}`; `X-PAYMENT-RESPONSE` carries the transfer id.

## The demo

Both demo URLs come from one base — `<PUBLIC_API_URL>/x402-demo`, falling back to the directory `resourceUrl` sits in
(`https://www.novicorpus.com/backend/x402-demo`) when the env is unset. With it set: the pinned wall (its own policy
regardless of `X402_TRUST_POLICY`; settles) is `https://api.novicorpus.com/x402-demo/legal-bodies-wall`, advertised
and signed against at the very URL it is served on; the run is `https://api.novicorpus.com/x402-demo/legal-bodies-run`
(one per 5 s, else `{"error":"slow-down","detail":"one run every 5 seconds"}`).

The run returns `{policy, resource, runUrl, statement, legs, expected, thirdLeg}`: leg 1 `anonymous` = 403
`human_backing_required` / `no-proof-presented`; leg 2 `human-backed, no legal body` = 403 `legal_body_required` /
`not-legal-body` with the `how` block, signed live by the Lisbon proof agent from leg 1's own challenge. It spends
neither money nor budget — no `settle`, its own rate key (`…#legal-bodies-run`), `allowancePerHuman: 10_000` — so runs
never turn leg 2 into a 429 and the real wall keeps `WORLD_ALLOWANCE_PER_HUMAN` (3 per 24 h). Record it any time.

**Leg 3, the payment that goes through — from the product.** Use agent 843704 (TestMB2): AgentBook-registered AND a
Novi legal body whose lookup answers yes: "a registered legal body stands behind this address, and Novi states
its standing as active". There is no dashboard button; the payment surface is the MCP tool `pay`, and the
pocket needs Gateway float (`fund_pocket`) first:

```
pay { id: "<the entity's idempotency key>", to: "https://api.novicorpus.com/x402-demo/legal-bodies-wall",
      amountUsdc: "10000",  /* atomic USDC = 0.01 */  idempotencyKey: "<fresh>" }
```

In order (`payments/buyer.ts`, the strict-wall recovery): (1) the first request carries NO `agentkit` header —
deliberately: a non-strict but AgentKit-aware seller would otherwise spend an allowance unit on every purchase — so
the wall answers **403** `human_backing_required` / `no-proof-presented`, challenge in `extensions.agentkit`; (2) the
buyer checks that challenge names the host it is buying from, mints the proof with the agent's own pocket AgentKit
signer (World Chain, `eip155:480`) and retries the SAME request ONCE, nothing signed for money; (3) human-backed AND a
legal body → **402** invoice, carrying `X-AGENTKIT-HUMAN`, `X-AGENTKIT-AUTHORIZATION` and `X-NOVI-LEGAL-BODY: 843704`;
(4) authorize → the paid retry carries a FRESH proof from the 402's own challenge (the seller consumes each nonce on
first use) plus `X-PAYMENT` → **200**, same header, `legalBody: {"agentId":"843704"}`, and `pay` returns
`{"ok":true,"txOrTransferId":"<id>"}`. Pay the `api.novicorpus.com` URL: on the proxy the header is dropped unless the
interface at HEAD is live.

**What a failed leg 3 looks like.** A second 403 (proof in hand, no body behind the payer) is terminal and `pay`
quotes the seller:
`{"ok":false,"txOrTransferId":null,"reason":"resource-403-after-proof: legal_body_required (not-legal-body): this seller trades only with agents that a registered legal body stands behind, one whose standing Novi states as active"}`.
Nothing was signed, so the claim is released and the key retries once the agent has a body. A bare `resource-403`
means no usable challenge (or no World layer: no signer, no recovery); `challenge-origin-mismatch`, a challenge naming
another site; `resource-503`, that the check could not be made — retry, it costs no allowance.

## Acceptance (design §6)

```bash
API=https://api.novicorpus.com
# 1, 2 — a known active body, then an address we have no entity for
curl -s $API/legal-bodies/0xeE85Fd00521d1Aa4c510BDdAb78F375830119354 | jq '.legalBody, .standing, .agentId'
curl -s $API/legal-bodies/0x000000000000000000000000000000000000dead | jq '.legalBody, .standing'
# 3 — the two refusal legs
curl -s $API/x402-demo/legal-bodies-run | jq '.legs[] | {name, status, error: .body.error, reason: .body.reason}'
# 4 — the third leg, from the product: MCP `pay` from 843704 to $API/x402-demo/legal-bodies-wall, amountUsdc "10000"
# 5 — the buyer dial is unchanged by the refactor
cd back/backend && npx vitest run test/payments/sellerTrust.test.ts
```

## Deploy

ONE env addition on the box, then the usual deploy (pull, build) and a restart:

```bash
# in the backend directory, as the service user
echo 'PUBLIC_API_URL=https://api.novicorpus.com' >> .env
sudo systemctl restart legalbody-api
```

It is optional — unset, the lookup's and the wall's links fall back to `METADATA_BASE_URL` (the www proxy) and nothing fails to boot
— but without it `how.lookup` and the advertised wall point at the hop that strips CORS, `Cache-Control` and
`X-NOVI-LEGAL-BODY`, and the paid `/verify` quote names the request's own `http://` address. The wall mints its
challenges for whatever base it advertises. `X402_TRUST_POLICY` stays `open`
(the demo wall pins its own), and **redeploy the interface too** (Vercel): only that lets `X-NOVI-LEGAL-BODY` survive
the `www/backend` hop. Then run the acceptance legs.

## What to watch — `journalctl -u legalbody-api -f | grep opslog`

- `legal_body_lookup` — one JSON line per memo MISS: `{"matchedBy":"pocket"|"treasury"|"statement"|"pot"|"none","standing":…}`
  (`statement` for a Minimal legal body, `pot` for one found by a pot it declared). Never the address.
- `legal_body_lookup_throttled` — `{"bucket":"client"|"shared"}`, at most once per 60 s whatever the volume.
- `attestation_key_loaded`: once at boot, `{"attestor":"0x…"}`, the attestor's public address; compare it with the ENS
  record `com.novicorpus.attestor`. `legal_body_statements_off` `{"reason":"no_attestation_key"}` instead: the
  legal-body feature is on and no statement can be signed.
- `legal_body_statement`: one line per signed statement, `{"agentId","standing","bindingState"}`.
- `legal_body_statement_unavailable`: `{"stage":"snapshot"|"code"|"sign","errorName"}`, a chain read or the signature
  failed, so the answer was an unsigned `unknown` (or `/transparency` could not read its legal-body section).
  Repeating: a node problem.
- `legal_body_statement_integrity` (`{"legalBodyId","problem"}`: the chain disagrees with a row, or the row is not one
  this deployment states) and `legal_body_statement_unlisted_body` (`{"agentId"}`: the chain links a body with no
  public row here): no statement is made. Both are worth an alarm.
- `legal_body_statement_log_failed`: `{"legalBodyId","errorName"}`, the statement was served and its log row not
  written.
- `legal_body_statement_throttled`: the by-agent route's throttle line, `{"bucket"}`, at most once per 60 s.
- `legal_body_statement_db_failed`: `{"errorName"}`, a database read of the statement failed: the 503 of the by-agent
  route, or of the address route's Minimal branch (the full-product resolver's own 503 writes no line).
- The seller logs nothing per request. It warns ONCE at boot (`console.warn`, same unit log) when
  `legal-bodies-only` has no `agentkit` config or no resolver: "every request is refused 503", and it is.

## Records

| Date (UTC) | Agent | Wall | Payer address | Settlement id | Header seen | Notes |
|---|---|---|---|---|---|---|
| _(first successful third leg goes here)_ | | | | | | |
