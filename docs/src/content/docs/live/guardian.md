---
title: "The guardian"
description: "The one person who answers for the company, how World ID checks them, and what they can do."
section: "minimal-novi"
register: "plain"
network: "arc-mainnet"
reviewed: 2026-11-06
---

<!-- Sources: the HonKit pages product/guardian.md and identity/world.md, with the fact fixes of audit note B (guardian rows 1, 15, 16; World rows 1 to 9; "the mainnet guardian"); LegalBodyFactory.sol (guardian-signed amendments, 48 hours to 30 days, only the guardian dissolves). The testnet controls moved to /testnet/treasury-product/ and AgentBook to /testnet/agentbook/. Rewritten in full at step 2 (design 3.3). -->

The guardian is the one person who answers for the company and its agents. In the record, the guardian is a wallet: the one you sign in with. World ID shows the guardian is one real person; an identity check says who. The name is held, never published.

## World ID

- World ID gives Novi Corpus a number that is the same each time you prove yourself to us, and different for any other app. It sends us no name, image or document.
- One person can hold one account. That account can be the guardian of several companies and agents.
- A legal body needs a World ID credential from an Orb, a passport or a Japanese My Number Card. Credentials that only prove a device are refused.
- A waiver is never accepted for a legal body.


## What the guardian can do

- **Approve the agreement**, and sign every change to it. A change waits in public at least two days and at most a month, and the guardian can stop it. A change the guardian did not sign cannot happen.
- **Close the legal body.** Only the guardian can start it. Closing the legal body does not dissolve the company.

Novi Corpus cannot change, close or empty a legal body on its own.

## Keep the wallet safe

The guardian's wallet is fixed. If you lose it, you lose the power to approve changes and to close the legal body. A hardware wallet is advised.
