---
title: "Minimal Novi"
description: "How a legal body works: its parts, the flow and the roles."
section: "minimal-novi"
register: "plain"
---

## How it works

Three lookups describe an agent:

```
  Human                  Name                         Money
  ┌───────────────┐      ┌──────────────────────┐     ┌──────────────────┐
  │  World ID     │      │  ENS                 │     │  Arc treasury    │
  │  uniqueness   │      │  <id>.novicorpus.eth │     │  cap, pause,     │
  │  (guardian)   │      │  ⇄ ERC-8004 on Arc   │     │  allowlist       │
  └───────────────┘      └──────────────────────┘     └──────────────────┘
```

1. **World ID** identifies the guardian as a unique human. AgentBook can show whether the paying address is linked to a verified human.
2. **ENS** maps `<id>.novicorpus.eth` to the treasury, legal status, and the Arc identity record.
3. **Treasury** holds USDC and enforces cap, allowlist, and pause on chain. The backend runs extra checks before it signs an x402 payment.

### Components

```
   Guardian                                Agent
   (wallet + passkey + World ID)           (MCP client)
            │                                      │
            ▼                                      ▼
   ┌─────────────────┐                   ┌─────────────────┐
   │  interface/     │                   │  MCP / REST     │
   │  Next.js app    │                   │  scoped key     │
   └────────┬────────┘                   └────────┬────────┘
            │                                     │
            └────────────► backend                 │
                           onboarding, policy,    │
                           payments               │
                                  │
                                  ▼
                     Arc testnet (USDC as gas)
                     Factory → LegalManager + AgentTreasury
                     ERC-8004 identity, ERC-8183 jobs
```

The web app and the MCP server call the same backend. The contracts do not depend on which one you used.

### Creating an entity

1. Sign in with a wallet ([SIWE](https://login.xyz/)) and register a WebAuthn passkey.
2. Prove uniqueness with World ID. The backend stores a **nullifier**, not a name.
3. If formation is enabled, name the natural person for the filing (or a labeled sandbox identity on demo).
4. Choose operator key custody: Circle MPC (default) or a Turnkey vault rooted in the passkey.
5. Set name, purpose, caps, allowlist, timelock. Typed in the wizard or drafted by an MCP agent.
6. The backend writes an operating agreement from those rules. The chain stores the hash.
7. The saga deploys `LegalManager` and `AgentTreasury`, registers ERC-8004 identity, binds the operator, records the guardian.
8. The platform wallet can fund the treasury, up to the configured cap.

If formation is enabled it continues after deploy. Filing does not block the on chain contracts. When EIN or documents change, a new hash is scheduled as a timelocked amendment. The guardian can veto it.

### Roles

| Role | Who | Powers |
| --- | --- | --- |
| Guardian | The human | Pause, unpause, veto policy and operating agreement amendments, set allowlist entries, rotate operator, emergency withdraw to the payout address, initiate or veto dissolution |
| Operator | The agent's spending key | `spend` inside the cap and allowlist. Signs. Does not hold the vault. |
| Manager | The platform (`NoviController` when configured) | `createEntity`, schedule policy and agreement updates, bind identity. Cannot skip the timelock or a guardian veto. |

Guardian, operator, and manager must be different addresses. The contracts revert otherwise.

## The legal body

Each agent is associated with a **Wyoming DAO LLC**. The spending rules you set become the operating agreement. A hash of that agreement is stored on chain in `LegalManager`.

### What the LLC is for

An address that only holds USDC cannot, by itself:

* Own off chain assets (bank account, trademark, domain, equipment) in its own name
* Be a party to a contract a court will enforce
* Limit the human operator's personal liability
* Receive an EIN or pass business KYC
* Keep a legal identity when keys rotate

A filed LLC can do those things. Until filing is complete, the on chain treasury still works. The EIN may still be `STUB-NOT-FILED`. See [Formation](/live/bring-your-own-agent/) and [Current status](/start/status/).

### Why Wyoming

The jurisdiction is Wyoming because of the [DAO LLC statute](https://wyoleg.gov/statutes/compress/title17.pdf) (W.S. 17-31-101 et seq., 2021):

* Articles can name a **managing smart contract**. That is the per agent `LegalManager` address.
* The operating agreement can describe algorithmic management.
* Governing smart contracts must be upgradeable. `LegalManager` is a beacon proxy.
* No state corporate income tax. Annual report minimum is $60.
* A Wyoming registered agent is required.

The operating agreement is private. Only the Articles are public. The chain stores a hash, not the document text.

### Human required

A company with no natural person is not the model used here. A natural person is required by:

1. **Wyoming DAO LLC statute** (W.S. 17-31-114): an entity not under the control of at least one natural person dissolves.
2. **FinCEN customer due diligence:** control attaches to a human.
3. **Circle's terms:** a named person at the identity perimeter.

That person is the on chain **guardian**. The agent is the operator and can only spend inside the treasury rules.

### How rules become the agreement

You set:

* A per transaction cap
* A rolling period cap and period length
* An optional recipient allowlist
* A timelock (hours before an amendment can execute)

The backend turns those values into operating agreement text and into constructor arguments for `AgentTreasury` and `LegalManager`. `LegalManager.meta.operatingAgreementHash` is the SHA-256 of the agreement, stored as `bytes32`.

When formation later adds an EIN, filing number, or document set, the backend builds a **bundle manifest** (JSON over terms, document hashes, legal facts, and on chain identity). The manifest hash becomes the new on chain hash, using the same timelocked amendment path. The guardian can veto it.
