---
title: "Networks and addresses"
description: "Chains, contracts and addresses."
section: "developers"
register: "technical"
reviewed: 2026-11-06
---

<!-- Sources: the HonKit page reference/networks.md, with the fact fixes of audit note E (networks rows 1 to 20 and its contract table, checked on chain on 6 November): native gas has 18 decimals, the current contracts replace the June generation, legacy hosts removed. Rewritten at step 2 with Arc mainnet first (design 3.3). -->

## Arc testnet

| Field | Value |
| --- | --- |
| Chain ID | `5042002` |
| RPC | `https://rpc.testnet.arc.io` |
| Explorer | [explorer.testnet.arc.io](https://explorer.testnet.arc.io) |
| Native gas | USDC (18 decimals natively) |
| ERC-20 USDC interface | `0x3600000000000000000000000000000000000000` (6 decimals) |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
| Faucet | [faucet.circle.com](https://faucet.circle.com) |

### Our contracts

`NoviController` owns the factories and the beacon. Each Minimal Novi legal body is an immutable clone of the `LegalManager` implementation, created by `LegalBodyFactory`; Novi Corpus cannot upgrade it. Novi Managed creates a `LegalManager` proxy and an `AgentTreasury` per agent through `LegalManagerFactory`. Neither kind of per agent contract is listed here.

| Contract | Address |
| --- | --- |
| `NoviController` | [`0x9526E228E94A125843B2d010c1155780CBBAFb5c`](https://explorer.testnet.arc.io/address/0x9526E228E94A125843B2d010c1155780CBBAFb5c) |
| `LegalBodyFactory` (Minimal Novi) | [`0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456`](https://explorer.testnet.arc.io/address/0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456) |
| `LegalManager` implementation | [`0xc2e89ABf562f2EB366e4dde42325af16EeF542a6`](https://explorer.testnet.arc.io/address/0xc2e89ABf562f2EB366e4dde42325af16EeF542a6) |
| `LegalManagerFactory` (Novi Managed) | [`0x83D529E813Fe825b84250034A7A63f460A2ECA77`](https://explorer.testnet.arc.io/address/0x83D529E813Fe825b84250034A7A63f460A2ECA77) |
| Upgrade beacon (Novi Managed) | [`0x432ed0814FcDDd03330add098093482128Ad2CfD`](https://explorer.testnet.arc.io/address/0x432ed0814FcDDd03330add098093482128Ad2CfD) |

Legacy (the June 2026 generation, which creates no new agents): `LegalManagerFactory` `0x91997dFcDE0046eA4AbE67a5De9E1DF54c9B6902` and its beacon `0xCbE36eC37673805a185a6883f9597613ABB41c97`.

Machine readable copy: [`back/addresses.arc-testnet.json`](https://github.com/jb1011/Novi-Corpus/blob/main/back/addresses.arc-testnet.json).

### Reused Arc infrastructure

| Contract | Address |
| --- | --- |
| ERC-8004 IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| ValidationRegistry | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` |
| ERC-8183 Job (on Arc testnet; none on Arc mainnet) | `0x0747EEf0706327138c69792bF28Cd525089e4583` |

### Subgraph

[novi-corpus-arc on The Graph Studio](https://api.studio.thegraph.com/query/1756954/novi-corpus-arc/v0.0.1): it indexes the legacy factory only and is not maintained.

## Ethereum Sepolia

ENS parent `novicorpus.eth`, wildcard `OffchainResolver`, CCIP-Read gateway on the Novi Corpus API. Coin type for Arc testnet in ENSIP-11 form: `2152525650` (`0x80000000 | 5042002`).

## World Chain

AgentBook registry lookups, at World's public AgentBook `0xA23aB2712eA7BBa896930544C7d6636a96b944dA`.

## App origins

| Surface | URL |
| --- | --- |
| Web app | [www.novicorpus.com](https://www.novicorpus.com) |
| API (Arc testnet) | `https://api.novicorpus.com` |
| Docs | [docs.novicorpus.com](https://docs.novicorpus.com) |
