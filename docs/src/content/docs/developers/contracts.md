---
title: "Contracts and security"
description: "The contracts and their roles."
section: "developers"
register: "technical"
reviewed: 2026-11-06
---

<!-- Sources: the HonKit page developers/contracts.md, with the fact fixes of audit note E (PUSH0 row 2) and the DAO wording of design 2.1. Rewritten at step 3 (design 3.3), with the Minimal Novi contracts and the security sentence of decision 8. -->

This page describes the contracts of Novi Managed on Arc testnet. The Minimal Novi contracts (`LegalBodyFactory` and the legal bodies it creates) are described here at the mainnet go-live.

Solidity 0.8.24, Foundry, `evm_version = "paris"`: the deployed bytecode was built with it, so keep it for the live-code checks to match. Sources live in [`back/src/`](https://github.com/jb1011/Novi-Corpus/tree/main/back/src). Tests: unit, fuzz, invariant, security, plus fork tests against live Arc registries.

## `LegalManagerFactory` (Novi Managed)

Entry point. `createEntity(...)` is owner only (the controller in production). In one transaction it:

1. Registers the ERC-8004 identity
2. Deploys a beacon proxy `LegalManager` for this agent
3. Deploys an immutable `AgentTreasury`
4. Wires roles, cap, period, payout, agreement hash
5. Transfers the identity NFT to the manager

The created body's `manager` must be the factory owner (`NoviController`). That is tested. If the factory owner is a hot EOA, that key is manager of every new vault and cannot be rotated on `AgentTreasury` (manager is immutable).

Per agent contracts are **not** in `addresses.arc-testnet.json`. They appear at runtime.

## `LegalManager` (Novi Managed)

Upgradeable via beacon, on Novi Managed. Holds `LegalMeta` (EIN, formation date, `operatingAgreementHash`, `agentId`). Amendments: schedule → optional guardian veto → execute after `amendmentDelay` (minimum 1 hour). Dissolution uses the same delay. Guardian veto of a hash lasts until the guardian lifts it.

## `AgentTreasury`

Not upgradeable. Immutable `usdc`, `legalManager`, `manager`, `guardian`, `policyDelay`. Operator spends. Guardian pauses, withdraws to payout, sets allowlist, rotates operator, vetoes policy. Manager only schedules / executes policy after delay.

`MIN_POLICY_DELAY` is 1 hour. `MAX_POLICY_PERIOD` is 365 days (overflow and freeze protection).

## `NoviController`

Access control relay. Admin is two step with a 24 hour default delay (`AccessControlDefaultAdminRules`). Executor holds selector roles such as:

* `createEntity`
* `schedulePolicyUpdate` / `executePolicyUpdate`
* `scheduleOperatingAgreementUpdate` / `executeOperatingAgreementUpdate`
* `setAgentWallet` / `setMetadata` on the identity registry

Some selectors are **pinned** to a target (for example identity calls) so the executor cannot aim them at an arbitrary contract.

`BreakGlassOneShot` is a companion for a single emergency call path. See [`back/src/BreakGlassOneShot.sol`](https://github.com/jb1011/Novi-Corpus/blob/main/back/src/BreakGlassOneShot.sol).

## `OffchainResolver`

ENS wildcard + CCIP-Read. Deployed on Sepolia, not on Arc. Signatures from the gateway key must match what this contract expects.

## Roles must differ

Factory / treasury constructors revert if guardian, manager, and operator are not three distinct addresses. Do not "simplify" a local demo by reusing one key across roles.

## Tests and reviews

An internal security review of the vault and manager found no Critical or High at the time of the first testnet deploy. That is not an independent audit. Fork tests against the live IdentityRegistry exist because NFT transfer clearing `agentWallet` is easy to get wrong in a mock.
