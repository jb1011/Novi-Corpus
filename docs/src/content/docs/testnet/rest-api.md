---
title: "REST API"
description: "The REST API behind the app and the MCP server."
section: "novi-managed"
register: "technical"
network: "arc-testnet"
reviewed: 2026-11-06
---

<!-- Sources: the HonKit page developers/rest-api.md, moved per design 3.4, with the fact fixes of audit note E (rows 3, 5, 18, 19, 32). -->

The brain listens on port `8789` by default (`npm run api` in `back/backend`). The Next app proxies same origin `/backend/*`.

Tenant for wizard routes is the SIWE address. Unless noted, routes below sit behind `requireAuth`. The three session routes are public.

This is a map, not an OpenAPI dump. Field level schemas live in the backend and in `GET /schema/agent-spec.json`.

## Session

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| `GET` | `/auth/nonce` | SIWE nonce | public |
| `POST` | `/auth/verify` | Exchange signature for JWT | public |
| `GET` | `/config` | Chain, formation flags, custody availability, public URLs | public |

`GET /config` is how the wizard knows whether to show legal identity and which custody options exist.

## Passkeys and keys

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/passkey/challenge` | WebAuthn challenge |
| `POST` | `/passkey` | Store attestation, return `passkeyId` |
| `POST` / `GET` / `DELETE` | `/api-keys` | Self service MCP keys |

## Onboard and entities

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/onboard` | Start saga |
| `GET` | `/entities` | List yours |
| `GET` | `/entities/:id` | Poll until `bound` |
| `POST` | `/entities/:id/fund` | Platform fund (provision class) |
| `GET` | `/entities/:id/reputation` | Job count: total, completed, with feedback on chain (owner only) |
| `GET` | `/entities/:id/external-record` | Graded record from the configured track-record provider (testnet; only where `EXTERNAL_RECORD_*` is set) |
| `GET` | `/entities/:id/agentbook` | AgentBook lookup of the **pocket** address |

## Policy, treasury, trust

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/entities/:id/policy` | Manager schedules an on chain policy update; `GET /entities/:id` then carries it as `scheduledPolicy` until executed |
| `PATCH` | `/entities/:id/per-tx-cap` | Software per transaction cap (decimal string) |
| `PATCH` | `/entities/:id/trust-policy` | The agent's buyer dial |
| treasury routes | status, pause related reads | Dashboard |

## Connection (MCP paste)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/connection-package` | Entity scoped key + snippets |
| `POST` | `/bootstrap-connection` | Tenant wide provision key + link code |

## World, formation, documents

| Method | Path | Purpose |
| --- | --- | --- |
| World ID routes | verify proof | Guardian gate |
| `POST` | `/formation-party` | PII intake, returns `partyId` |
| Filing provider webhook | inbound HMAC | Wake up only |
| document routes | list / download | Hashed legal files |

## Public (little or no auth)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/metadata/:publicId` | Agent metadata JSON |
| ENS gateway | CCIP-Read | Wildcard resolution |
| transparency | stats + registry | `/transparency` in the app |
| x402 demo | 402 challenge + resource | Personhood demo |

## Errors

JSON envelope. MCP tools stringify their own result or `"not found"`. Do not parse HTML. Pass an `idempotencyKey` on `POST /onboard` (it defaults to the agent's name) and on the MCP `pay` tool (required).
