---
title: "The guardian"
description: "The guardian's controls, and the World ID step."
section: "minimal-novi"
register: "plain"
---

## Guardian controls

The guardian is the natural person behind the LLC and an on chain role. The agent cannot change that role.

### Powers on `AgentTreasury`

| Action | What it does |
| --- | --- |
| `pause` / `unpause` | Stops or resumes `spend`. Immediate. |
| `emergencyWithdraw` | Sends the full USDC balance to the **payout address** (not automatically to your wallet). |
| `setAllowlistEntry` | Add or remove a recipient. |
| `setOperator` | Change the spending key. |
| `vetoPolicyUpdate` | Block a scheduled cap or policy change. |

### Powers on `LegalManager`

| Action | What it does |
| --- | --- |
| Veto a scheduled operating agreement update | Blocks that hash until you lift the veto |
| Lift a veto | Lets the manager schedule or execute again |
| Initiate dissolution | Starts a timelocked wind down |
| Veto dissolution | Stops a dissolution the other role started, if it is not yet finalized |

Status only moves forward: `Active` → `WindingDown` → `Dissolved`. `spend` stops when status is not `Active`. Remaining assets can be swept only while winding down.

### What you sign

1. **SIWE** to log into the app
2. **WebAuthn passkey** (also the Turnkey vault root if you chose that custody)
3. **One transaction per allowlist address** at deploy, from your wallet

Funding the treasury does not need your signature. Policy updates are proposed by the manager and wait in the timelock.

### World ID

Onboarding requires proof of personhood, or an admin issued waiver if the deployment allows it. See [World ID](/live/guardian/#world-id-1).

The stored nullifier is unique per human for this app. The same person cannot open a second guardianship.

### If the agent misbehaves

1. Pause.
2. Rotate the operator if the spending key may be leaked.
3. Emergency withdraw if funds should go to the payout address now.
4. Veto any pending amendment you did not expect.

The dashboard amendment card reads a known hash with a mapping call. Discovering hashes from logs can fail on a pruned RPC. The mapping read is what marks a hash as live.

## World ID

Wyoming DAO LLCs need a natural person. A passkey proves control of a device. World ID proves the guardian is a **unique human**.

The explainer in the app is `/personhood`. `/proof` redirects there.

### What is stored

Verification returns a **nullifier**:

* The same human, proving to this app, always produces the same nullifier.
* A different app sees a different number.
* Name, iris, document, and face are not received.

A second guardianship with the same human hits the same nullifier and is refused.

### What is accepted

The request offers **Orb** and **passport / MNC** document tiers. Device only credentials are rejected. Production entity creation uses Orb or NFC passport grade.

Deployments may allow an **admin issued waiver** when the human has no World ID path. That is logged and optional.

### AgentBook

[AgentBook](https://docs.world.org/) is World's registry on World Chain. A lookup asks whether a paying address is linked to a verified human.

* Look up the address that **signed** the payment. That is the **pocket** EOA, not the operator smart account. The operator address will read as unregistered.
* AgentBook has no unregister.
* Registration is a separate flow from the guardian gate. Until that flow ships, do not register the operator address. That bind cannot be undone.

### Trust policy

If a seller sets `X402_TRUST_POLICY=accountable-only`, a buyer with no human backing gets HTTP `403` and a remediation body, not a `402` payment challenge. No payment is taken.

Rate limits that are per human apply across all agents that share that human.

### Split of duties

World ID does not pause the treasury, withdraw funds, or file an LLC. Those are guardian powers and formation. See [Guardian controls](/live/guardian/) and [Formation](/live/bring-your-own-agent/).
