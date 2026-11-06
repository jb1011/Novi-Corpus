---
title: "The account: caps, allowlist, pause"
description: "The agent's USDC account, who holds its keys, and the onboarding flow."
section: "novi-managed"
register: "technical"
network: "arc-testnet"
---

## Treasury and policy

Each agent gets its own `AgentTreasury`: an immutable USDC vault on Arc. The operator spends. The guardian can stop it. The manager can propose policy changes, never instant ones.

### What the vault holds

USDC on Arc (6 decimals). On Arc, USDC is also the gas token. The vault is **not upgradeable**. There is no admin key that can drain beyond the rules encoded at deploy and later amended through the timelock.

### On chain rules

| Rule | Effect |
| --- | --- |
| Rolling period cap | `available()` is `cap - spentInWindow`. The window resets after `period`. Max period is 365 days. |
| Allowlist | If `allowlistEnabled`, `spend` reverts unless `isAllowed[to]`. The guardian toggles entries. |
| Pause | Guardian can pause and unpause. `spend` reverts while paused. |
| Legal status | `spend` reverts unless the linked `LegalManager` is `Active`. |
| Payout address | Emergency withdraw always goes here, never to an arbitrary address the caller types. |
| Policy delay | At least 1 hour. Manager schedules a new cap, period, payout, or allowlist flag. Guardian can veto. After the delay, manager executes. |

`spend(to, amount)` is `onlyOperator`. The operator key signs. It does not own the USDC. Custody of the vault is the contract.

### Software rules (Payment Authority)

Before the backend signs an x402 payment it re-reads chain state and also applies:

* **Per transaction cap.** Not a Solidity check. Enforced in software, then the on chain period cap still applies.
* **Hybrid allowlist.** Chain allowlist plus any extra software list.
* **Trust policy.** Seller side: `open` or `accountable-only` (refuse buyers with no human backing). Buyer side: `open` or `verified-sellers-only`. Default for both is `open`.
* **Entity must be bound, not paused, legally Active.**

These checks fail closed. Nothing is signed if they fail. Idempotency keys mean a retry after a denial does not double spend.

### Two wallets around the vault

Payments do not always leave the treasury in the same transaction as the HTTP 402.

1. **Treasury** (the contract). Long term store. Period cap lives here.
2. **Pocket.** A short lived float used to settle x402 through Circle Gateway. Top up with `fund_pocket` (MCP) or the dashboard equivalent. Explicit only. `pay` never auto tops up.

A spend that would exceed the on chain remaining cap cannot be made good by filling the pocket.

### Funding

On the hosted product, the **platform wallet** transfers testnet USDC into the treasury. You pick the amount. You do not sign the funding transfer.

Limits (defaults, deployment configurable):

* `MAX_TREASURY_FUND_USDC`: 25 USDC per call
* `MAX_TREASURY_FUNDED_PER_TENANT_USDC`: 100 USDC lifetime per tenant

There is no in app faucet. Amounts above those caps are refused.

### Policy updates

Changing cap, period, payout, or allowlist enabled:

1. Manager (platform) calls `schedulePolicyUpdate`.
2. The change sits until `executableAt`.
3. Guardian may `vetoPolicyUpdate`. A vetoed policy id cannot execute until the guardian lifts it (same pattern as operating agreement hashes).
4. After the delay, manager `executePolicyUpdate`.

The dashboard reads amendment state from **your RPC**, not from the backend's word. A hash is shown as live only because a point read on chain said so.

## Custody

**Custody** here means who holds the agent's **operator key** (the key that calls `spend`). It does not mean who holds the USDC. USDC sits in `AgentTreasury`. The guardian wallet keeps pause, veto, and emergency withdraw on both options.

### Options

| Option | Operator key | Gas | Root of the operator key |
| --- | --- | --- | --- |
| Circle MPC (default in the wizard) | Circle MPC smart account | Agent does not pay gas | Platform |
| Turnkey | Turnkey enclave key | Platform sends the bind transaction | Your WebAuthn passkey |

The **pocket** used for x402 is platform managed on both options. Only the operator key changes.

### Circle MPC

The platform takes part in operator signing. It can sign spends as the operator. It cannot skip guardian pause, veto, or withdraw to the payout address. It cannot spend as operator if you chose Turnkey instead.

### Turnkey

The operator key is in a Turnkey vault whose root is your passkey. The platform still sends some transactions (bind, funding) from the manager role. It does not hold that operator key.

### Passkeys

A passkey is always registered. On Circle MPC it is used for human approval where the flow needs it. On Turnkey it is also the root of the operator vault. An MCP agent cannot complete WebAuthn, so agent first onboard still starts in the browser.

### Manager vs guardian

**Manager** is the platform (`NoviController` when `CONTROLLER_ADDRESS` is set). It creates entities and schedules amendments. It cannot `spend` as operator and cannot skip your veto window.

**Guardian** is the wallet you used at onboard. If you lose it and have no recovery, you lose pause and withdraw.

## Onboarding

The wizard at `/onboarding` is the human path. MCP `onboard_agent` is the agent path. Both run the same saga on the backend. You can close the tab. The saga resumes.

### Phases (human wizard)

The step numbers depend on whether this deployment forms companies. If formation is off, the legal identity step is hidden and the remaining steps renumber.

| Phase | What you do |
| --- | --- |
| Wallet and passkey | SIWE with your wallet. Create a WebAuthn passkey (Face ID, Touch ID, or a security key). |
| Accountable human | World ID proof. Orb, passport, or another accepted document tier. Device only proofs are rejected. |
| Legal identity | Only if formation is available. Name the responsible natural person, or accept the labeled sandbox identity on demo. |
| Key custody | Novi managed Circle MPC (default) or Turnkey vault rooted in your passkey. |
| Define agent | Name, purpose, per transaction cap, period cap, allowlist, timelock. Manual form or MCP draft. |
| Operating agreement | Review the generated agreement. The hash is what will be stored on chain. |
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

`POST /onboard` and `onboard_agent` take an idempotency key. Retrying the same key does not mint a second LLC. The runner keeps an in flight set so two doors cannot race the same mint.

### What "bound" means

The entity has:

* A `LegalManager` proxy and an `AgentTreasury`
* An ERC-8004 `agentId`
* An operator key bound as `agentWallet`
* You as `guardian`
* A public id used in ENS and metadata URLs

Formation may still be in progress. Bound is the on chain body, not "the Secretary of State is done."
