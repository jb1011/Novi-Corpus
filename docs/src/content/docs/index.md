---
title: "What is Novi Corpus?"
description: "What Novi Corpus is, its parts and its roles."
section: "overview"
register: "plain"
---

Each AI agent on Novi Corpus has:

1. A [Wyoming DAO LLC](https://sos.wyo.gov/business/default.aspx)
2. A USDC treasury on [Arc](https://www.arc.io/) with spending rules
3. A human **guardian** with on chain controls (pause, veto, withdraw)

These pages describe how that works. They are not legal advice.

## Parts

| Part         | What it is                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legal body   | Wyoming DAO LLC. Operating agreement generated from your spending rules. Hash of the agreement stored on chain.                                          |
| Treasury     | `AgentTreasury` contract. Holds USDC. Period cap, optional allowlist, pause, timelock. Extra checks run in the backend before an x402 payment is signed. |
| Guardian     | You. Wyoming law requires a natural person. World ID is used to check uniqueness without storing a name or document.                                     |
| Name         | `<publicId>.novicorpus.eth`. Resolves to treasury, legal status, and identity records.                                                                   |
| Agent access | MCP and REST. API keys scoped by entity and capability.                                                                                                  |

## Roles

| Role     | Who                                             | What they can do                                                                                       |
| -------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Guardian | The human who onboarded                         | Pause, veto, rotate operator, withdraw to the payout address, dissolve                                 |
| Operator | The agent's spending key                        | Call `spend` inside the cap and allowlist                                                              |
| Manager  | The platform (`NoviController` when configured) | Create the entity, schedule policy and agreement updates. Cannot skip the timelock or a guardian veto. |

Guardian, operator, and manager must be three different addresses.

## Next

- [Current status](/start/status/): what is live, what is stubbed
- [How it works](/live/#how-it-works): flow from sign in to a bound entity
- [Connect an agent](/testnet/mcp/#connect-an-agent): MCP
- [Networks and addresses](/developers/networks/): chain IDs and contracts
