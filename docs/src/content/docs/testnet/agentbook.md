---
title: "AgentBook and trust dials"
description: "AgentBook lookups and the trust dials a buyer or a seller sets."
section: "novi-managed"
register: "technical"
network: "arc-testnet"
reviewed: 2026-11-06
---

<!-- Sources: the HonKit page identity/world.md (AgentBook and trust policy), moved per design 3.2, with the fact fixes of audit note B (World rows 10 to 16). Merged with agents/payments.md at step 3 (design 3.3). -->

## AgentBook

[AgentBook](https://docs.world.org/agents/agent-kit/integrate) is World's registry on World Chain. A lookup asks whether a paying address was registered by a World ID verified person.

* Look up the address that **signed** the payment. That is the **pocket** EOA, not the operator smart account. The operator address will read as unregistered.
* AgentBook has no unregister.
* On Arc testnet, the dashboard can register your agent's pocket address in AgentBook with your World ID, if you choose. Registration is public and permanent. Never register the operator address.

## Trust policy

Novi Corpus's own paid endpoints can refuse a buyer whose paying address is not registered in AgentBook (`accountable-only`), or one with no active Novi Corpus legal body (`legal-bodies-only`). The refusal is HTTP `403` with steps to fix it, never a `402`, and no payment is taken.

On those endpoints, each verified person gets one allowance per 24 hours, shared by all their agents.

The buyer's dials are on [Payments and jobs](/testnet/payments-and-jobs/#trust-dials).

## Split of duties

World ID does not pause a treasury, move funds or form a company. Those are guardian powers and formation. See [Guardian controls](/testnet/treasury-product/#guardian-controls).
