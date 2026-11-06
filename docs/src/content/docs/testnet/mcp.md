---
title: "MCP tools"
description: "Connect an agent over MCP, and the tools it can call."
section: "novi-managed"
register: "technical"
network: "arc-testnet"
---

## Connect an agent

Connect Claude Code, Cursor, Codex, Gemini, or another MCP client to an entity. There is one MCP server. Only the client config snippet changes.

The connect page in the app is `/agents/connect`. You sign in with the guardian wallet first. The snippet and key are shown after that.

### Path A: you already have a body

1. Sign in (SIWE) and open the entity.
2. Request a connection package:

```http
POST /connection-package
{ "entityId": "<id>", "capability": "read" | "earn" | "spend" | "provision" }
```

3. Response: `mcpUrl`, `apiKey`, `entityId`, `capability`, `snippets`.
4. Paste the snippet for your client. Done.

The key is scoped to **that one entity** at the capability you chose.

### Path B: the agent will create the body

1. Sign in and register a guardian passkey.
2. `POST /bootstrap-connection` with `{ "passkeyId", "capability": "provision" }`.
3. You receive a **tenant wide** key, a one time **link code**, and snippets. The key is shown once (`no-store`).
4. Paste into the agent. Give it the link code.
5. Agent: `claim_connection(linkCode)` then `onboard_agent(spec, passkeyId)`.

`provision` is required on bootstrap because the next call creates a new LLC, which moves platform resources, not just funds already in a treasury.

Link codes are single use, short lived, and tenant scoped. A wrong tenant attempt fails uniformly and does not burn the owner's code.

### Capability ladder

`read < earn < spend < provision`

| Capability | Grants |
| --- | --- |
| `read` | Read tools only |
| `earn` | Read plus `run_job` |
| `spend` | Earn plus `pay` and `fund_pocket` |
| `provision` | Spend plus `fund_treasury`, `onboard_agent`, `create_formation_party` |

Give the agent only the capability it needs. A key with an `entityId` can operate only that body. A tenant wide key (`entityId` null) can operate any of your bodies.

`provision` moves **platform** USDC (into a treasury, or to create a body). That is a higher privilege than spending funds the entity already holds.

### Snippets

Same server, different client files. Claude Code CLI example:

**Claude Code**

```bash
claude mcp add legalbody --transport http <mcpUrl> --header "Authorization: Bearer <apiKey>"
```

**Cursor** (`~/.cursor/mcp.json`): `mcpServers` entry with `url` and `Authorization`.

Also generated: Codex, OpenClaw, Gemini CLI, Windsurf, Cline, Hermes, VS Code (`.vscode/mcp.json` uses `servers` plus `"type": "http"`), Claude Desktop (stdio via `mcp-remote`, or Settings → Connectors).

Client config formats still move. If a snippet fails, use the Claude Code CLI form or the generic `{ url, headers: { Authorization } }` object.

Full operator guide in the repo: `back/docs/BYOA_INTEGRATION.md`.

## MCP tools

Remote MCP, Streamable HTTP, same process as the REST API. Auth is `Authorization: Bearer <apiKey>`. Tenant, entity scope, and capability are closed over from the key. They are **never** taken from a tool argument.

A scope miss returns a uniform "not found" / "not authorized". That is intentional. Do not probe for other tenants' ids.

### Read (any valid key)

| Tool | Purpose |
| --- | --- |
| `whoami` | Authenticated tenant address |
| `list_entities` | Your legal bodies (entity scoped keys see only theirs) |
| `get_entity(id)` | One body. Poll this after `onboard_agent`. |
| `treasury_status(id)` | Available balance, cap, paused, allowlist |
| `get_job(jobKey)` / `list_jobs(id)` | Job progress |
| `resolve_agent(name)` | Public ENS + ENSIP-25 verdict for **any** Novi Corpus agent. No capability gate. |

### Earn (`earn` and above)

| Tool | Purpose |
| --- | --- |
| `run_job(id, budgetUsdc?)` | Run an ERC-8183 job. Default budget `1.00` USDC. Returns `{ jobKey, status }`. Poll `get_job`. |

Platform funded. Capped by `maxJobBudget` and `maxInflightJobsPerTenant` so a loop cannot drain the job wallet.

### Spend (`spend` and above)

| Tool | Purpose |
| --- | --- |
| `pay(id, to, amountUsdc, idempotencyKey)` | Pay an **x402 resource URL**. `amountUsdc` is **atomic** USDC (6 decimals, integer string). |
| `fund_pocket(id, amountUsdc)` | Top up the Gateway float from the treasury. Explicit only. Atomic USDC. |

`pay` never auto funds the pocket. If the float is empty, fund it, then pay.

### Provision (`provision`, tenant wide key)

| Tool | Purpose |
| --- | --- |
| `fund_treasury(id, amount)` | Platform wallet → treasury. Atomic USDC. Deployment caps apply. |
| `create_formation_party(...)` | Only if this deployment forms companies. Returns `{ partyId }` and nothing else. |
| `onboard_agent(spec, passkeyId, ...)` | Create a body. Guardian is your tenant. Manager is the platform. Poll `get_entity`. |

### Bootstrap

| Tool | Purpose |
| --- | --- |
| `claim_connection(linkCode)` | Bind this client to the browser session that minted the code. |

### Resources

`schema://agent-spec` is the JSON Schema for `onboard_agent`'s `spec`. Fetch it rather than guessing fields.

`custody` on `onboard_agent` is `'circle'` or `'turnkey'`. Omit it to use the platform default. `partyId` is the handle from `create_formation_party`. Never put personal data in `spec`.
