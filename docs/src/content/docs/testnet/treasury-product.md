---
title: "The account: caps, allowlist, pause"
description: "The agent's USDC account, who controls its keys, the guardian's controls, and the onboarding flow."
section: "novi-managed"
register: "technical"
network: "arc-testnet"
reviewed: 2026-11-06
---

<!-- Sources: the HonKit pages product/treasury.md, product/custody.md, product/onboarding.md, product/guardian.md (treasury powers) and identity/registries.md (full product), moved per design 3.2 and 3.4, with the fact fixes of audit note B (rows 1 to 25 of treasury, 1 to 14 of custody, 3 to 18 of guardian) and note A (keccak256). -->

## Treasury and policy

Each Novi Managed agent gets its own `AgentTreasury`: an immutable USDC vault on Arc testnet. The operator spends. The guardian can stop it. The manager can propose policy changes, never instant ones.

### What the vault holds

USDC on Arc. The vault is **not upgradeable**. No key can move more than the on chain rules allow. Inside those rules, the platform runs the operator key and can spend up to the cap in each period. The guardian can pause at any time.

### On chain rules

| Rule | Effect |
| --- | --- |
| Period cap | `available()` is `cap - spentInWindow`. A window starts with the first spend after the previous one ended and lasts `period`, so two spends either side of a boundary can together reach twice the cap once. The longest period is 365 days. |
| Allowlist | If `allowlistEnabled`, `spend` reverts unless `isAllowed[to]`. The guardian toggles entries. Top-ups of the pocket are not checked against the allowlist; they count against the cap. |
| Pause | Guardian can pause and unpause. `spend` reverts while paused. |
| Legal status | `spend` reverts unless the linked `LegalManager` is `Active`. |
| Payout address | Emergency withdraw always goes here, never to an arbitrary address the caller types. The manager can propose a new payout address through the policy delay. The guardian can veto it. |
| Policy delay | At least 1 hour, set for each treasury when it is created. Manager schedules a new cap, period, payout, or allowlist flag. Guardian can veto. After the delay, manager executes. |

`spend(to, amount)` is `onlyOperator`. The operator key is run by the platform. The contract limits what that key can do.

### Software rules (Payment Authority)

Before the backend signs an x402 payment it re-reads chain state and also applies:

* **Per transaction cap.** Not a Solidity check. Enforced in software, then the on chain period cap still applies.
* **Allowlist above a threshold.** A payment above a set amount (1 USDC by default) must go to an address on the treasury's on chain allowlist, even when the allowlist is switched off.
* **Trust policy.** Seller side: `open`, `accountable-only` (refuses a buyer whose paying address is not registered in World's AgentBook) or `legal-bodies-only` (also requires an active Novi Corpus legal body). Buyer side: `open`, `verified-sellers-only` or `verified-legal-bodies-only`. Both default to `open`.
* **Treasury and legal body.** The treasury must not be paused, and the legal body must be `Active`.

These checks fail closed. Nothing is signed if they fail. Idempotency keys mean a retry after a denial does not double spend.

### Two wallets around the vault

Payments do not always leave the treasury in the same transaction as the HTTP 402.

1. **Treasury** (the contract). Long term store. Period cap lives here.
2. **Pocket.** A small float, run by the platform, kept under a fixed ceiling, used to settle x402 through Circle Gateway. Top up with `fund_pocket` (MCP) or the dashboard equivalent. Explicit only. `pay` never auto tops up.

A spend that would exceed the on chain remaining cap cannot be made good by filling the pocket.

### Funding

On Arc testnet, the **platform wallet** transfers testnet USDC into the treasury. You pick the amount. You do not sign the funding transfer.

Limits (defaults, deployment configurable):

* `MAX_TREASURY_FUND_USDC`: 25 USDC per call
* `MAX_TREASURY_FUNDED_PER_TENANT_USDC`: 100 USDC lifetime per tenant

There is no in app faucet. Amounts above those caps are refused.

### Policy updates

Changing cap, period, payout, or allowlist enabled:

1. Manager (platform) calls `schedulePolicyUpdate`.
2. The change sits until `executableAt`.
3. Guardian may `vetoPolicyUpdate`. A vetoed policy id cannot execute until the guardian lifts it with `liftVeto` (same pattern as operating agreement hashes).
4. After the delay, manager `executePolicyUpdate`.

The dashboard reads amendment state from **your RPC**, not from the backend's word. A hash is shown as live only because a point read on chain said so.

## Guardian controls

The guardian is the wallet you used at onboard. The agent cannot change that role.

### Powers on `AgentTreasury`

| Action | What it does |
| --- | --- |
| `pause` / `unpause` | Stops or resumes `spend`. Immediate. |
| `emergencyWithdraw` | Sends the full USDC balance to the **payout address** (not automatically to your wallet). |
| `setAllowlistEntry` | Add or remove a recipient. |
| `setOperator` | Change the spending key. |
| `vetoPolicyUpdate` | Block a scheduled cap or policy change. |
| `liftVeto` | Lets the manager propose a vetoed change again. |

### Powers on `LegalManager`

| Action | What it does |
| --- | --- |
| Veto a scheduled operating agreement update | Blocks that hash until you lift the veto |
| Lift a veto | Lets the change be proposed again, with a new delay |
| Initiate dissolution | Starts a timelocked wind down |
| Veto dissolution | Stops a dissolution the other role started, if it is not yet finalized |

A body can move from `Active` to `WindingDown`. A vetoed dissolution returns it to `Active`. `Dissolved` is final. `spend` stops when status is not `Active`. Once the delay has passed, either role can sweep what the body holds, during the wind down and after it.

### What you sign

1. **SIWE** to log into the app
2. **WebAuthn passkey** (also the Turnkey vault root if you chose that option)
3. **One transaction per allowlist address** at deploy, from your wallet

Funding the treasury does not need your signature. Policy updates are proposed by the manager and wait in the timelock.

### If the agent misbehaves

1. Pause.
2. Rotate the operator if the spending key may be leaked.
3. Emergency withdraw if funds should go to the payout address now.
4. Veto any pending amendment you did not expect.

The dashboard amendment card reads a known hash with a mapping call. Discovering hashes from logs can fail on a pruned RPC. The mapping read is what marks a hash as live.

If you lose the guardian wallet and have no recovery, you lose pause and withdraw.

## Custody

**Custody** here means who controls the agent's **operator key** (the key that calls `spend`). On Arc testnet, the platform runs the agent's operator key and its payment float, on both options below. The treasury contract limits what the operator key can do. The guardian wallet keeps pause, veto, and emergency withdraw on both options.

### Options

| Option | Operator key | Gas | Root of the operator key |
| --- | --- | --- | --- |
| Circle (the default on our testnet) | Circle MPC smart account | Agent does not pay gas | Platform |
| Turnkey (on Arc testnet) | Turnkey enclave key | Platform sends the bind transaction | Your WebAuthn passkey |

The **pocket** used for x402 is platform managed on both options. Only the operator key changes.

### Circle

The platform controls the operator key, held in Circle's MPC wallets. It can sign spends as the operator, inside the treasury's rules. It cannot skip guardian pause, veto, or withdraw to the payout address.

### Turnkey

The operator key is in a Turnkey vault whose root is your passkey. The platform signs with a key your passkey authorised. Your passkey is the vault's only root and can withdraw that authority. The platform also sends some transactions (bind, funding) from the manager role.

### Passkeys

A passkey is always registered. On the Circle option it is registered at onboarding and not used after it. On Turnkey it is also the root of the operator vault. An MCP agent cannot complete WebAuthn, so agent first onboard still starts in the browser.

### Manager and guardian

The **manager** role is held by Novi Corpus's controller contract (`NoviController`). It creates agents and proposes changes, and every change waits for your veto window. The manager role itself cannot spend; the platform spends through the operator key, inside the treasury's rules.

The **guardian** is the wallet you used at onboard. If you lose it and have no recovery, you lose pause and withdraw.

## Onboarding

The wizard at `/onboarding` is the human path. MCP `onboard_agent` is the agent path. Both run the same saga on the backend. You can close the tab. The saga resumes.

### Phases (human wizard)

The step numbers depend on whether this deployment forms companies. If formation is off, the legal identity step is hidden and the remaining steps renumber.

| Phase | What you do |
| --- | --- |
| Wallet and passkey | SIWE with your wallet. Create a WebAuthn passkey (Face ID, Touch ID, or a security key). |
| Accountable human | World ID proof. Orb, passport, or another accepted document tier. Device only proofs are rejected. |
| Legal identity | Only if formation is available. Name the responsible natural person, or accept the labeled sandbox identity on demo. |
| Key custody | Circle (default) or a Turnkey vault rooted in your passkey. |
| Define agent | Name, purpose, per transaction cap, period cap, allowlist, timelock. Manual form or MCP draft. |
| Operating agreement | Review the generated agreement. Its keccak256 hash is what will be stored on chain. |
| Deploy on chain | Saga: provision operator key, `createEntity`, bind wallet, write metadata, ENS reverse bind. |
| Fund treasury | Amount in USDC. Platform wallet sends. Capped. |
| Live | Dashboard for this entity. |

### Agent first

If the agent should create the body from a prompt:

1. You still sign in and register a passkey in the browser. An LLM cannot complete WebAuthn.
2. Open `/agents/connect` and request a **bootstrap** package at capability `provision`.
3. You get an MCP URL, an API key shown **once**, and a short lived **link code**.
4. Paste the snippet into the agent. Give it the link code.
5. The agent calls `claim_connection`, then `create_formation_party` if needed, then `onboard_agent`.
6. Poll `get_entity` until status is `bound`.

The bootstrap token's tenant is always your SIWE address. The agent never supplies the owner.

### Idempotency

`POST /onboard` and `onboard_agent` take an idempotency key; on `POST /onboard` it defaults to the agent's name. Retrying the same key does not create a second legal body. The runner keeps an in flight set so two doors cannot race the same mint.

### What "bound" means

The entity has:

* A `LegalManager` proxy and an `AgentTreasury`
* An ERC-8004 `agentId`
* An operator key bound as `agentWallet`
* You as `guardian`
* A public id used in ENS and metadata URLs

Formation may still be in progress. Bound is the on chain body, not "the Secretary of State is done."

## On chain identity

Novi Managed uses Arc testnet's existing registries. There is no separate Novi Corpus identity chain.

### ERC-8004

`createEntity` registers the agent in Arc's **IdentityRegistry** and deploys that agent's `LegalManager` and `AgentTreasury` in the same transaction.

| Registry | Address (Arc testnet) | Role |
| --- | --- | --- |
| Identity | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | Agent id, `agentWallet`, metadata URI |
| Reputation | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | Feedback after jobs |
| Validation | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` | Validation hooks |

The **manager** (`NoviController`) owns the identity NFT, so it can call `setAgentWallet` and `setMetadata` during onboard. Transferring the NFT clears the wallet binding. That is how the live registry behaves.

`agentWallet` is the operator key. The operator signs EIP-712 `AgentWalletSet`. The manager submits the transaction. The operator does not pay gas for bind.

Metadata is an HTTPS URI. Fetch `/metadata/<publicId>`.

### `LegalManager` (Novi Managed)

Each Novi Managed agent has a `LegalManager` proxy that records:

* EIN, formation date, operating agreement hash, `agentId`
* Status: `Active`, `WindingDown`, `Dissolved`
* Timelocked amendments with guardian veto
* Dissolution with the same delay

On Novi Managed, `LegalManager` is upgradeable through a **beacon** (one implementation, many agents). The Minimal Novi legal bodies are different contracts: see [Minimal Novi](/live/).

### `NoviController`

`NoviController` is the `manager` of new Novi Managed bodies and the owner of their factory and beacon. A cold admin grants roles. The backend executor may call only the granted selectors.

The vaults already have a timelock and guardian veto. The controller does not add another delay. `AgentTreasury.manager` is immutable.
