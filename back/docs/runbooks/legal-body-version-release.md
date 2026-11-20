# Runbook — Releasing a version of the legal body's code

Last revised: 2026-11-20

Contracts: `back/src/LegalBodyFactory.sol` (`publishVersion`, `withdrawVersion`),
`back/src/LegalBody.sol`, `back/src/BreakGlassOneShot.sol` · rehearsal:
`back/test/LegalBodyReleaseRehearsal.t.sol` · deploy: [minimal-mainnet-deploy.md](./minimal-mainnet-deploy.md).

## What a release does

A release adds one version of the legal body's code to the factory's list. It changes no body.

| Who | Can do | Cannot do |
|---|---|---|
| The controller's admin | Publish a version, withdraw a version | Move any body to a version |
| A body's guardian | Sign to move that body to a published version, and cancel during the body's delay | Move a body to code that is not on the list |
| Anyone | Send a guardian's signature, and execute an upgrade once its delay has passed | Anything without the guardian's signature |

The executor holds neither release selector. Both are pinned to the factory and granted to no one,
so each release is one ceremony: the admin grants the selector to a single-use helper, the helper
makes one call and gives the role back in the same transaction.

Withdrawing is permanent. A withdrawn version can be neither scheduled nor executed, even when an
upgrade to it is already waiting. Bodies already on it stay on it and can move to a later one.
Version 1 cannot be withdrawn.

## What a version must be

Check every row before any transaction. Nothing on chain can prove the first two.

| Requirement | Why |
|---|---|
| It inherits `LegalBody`. | The upgrade lock, the upgrade entry point and the counter read then cannot be replaced. |
| It never writes the ERC-1967 implementation slot, and writes `manager`, `guardian` or `amendmentDelay` only when that is the stated purpose of the version. | A body's code moves only through the factory, and its roles stay what its guardian agreed to. |
| It implements `migrate(uint256 fromVersion)` as `onlyManager reinitializer(N)`, even when there is nothing to set. | The factory calls it inside the upgrade and reverts the upgrade unless the body's counter then equals `N`. |
| `N` is the number the factory will list it under: `versionCount() + 1` at the time of publishing. | The number comes from the factory's list, not from the name the team gave the version. A withdrawn version still used its number. |
| Its migration is cumulative: it runs every earlier version's step that `fromVersion` has not had. | Guardians may skip versions. |
| It only appends storage: every variable of the version before it keeps its slot, offset and type. | A moved variable corrupts every body that upgrades. The storage tests in `back/test/LegalBodyUpgradeStorage.t.sol` compare layouts; add the new version to them. |
| It was reviewed, and its source is verified on the explorer at the address to be published. | A version is only as sound as its review and its verified source. |

## Before the ceremony

1. Deploy the candidate from a throwaway key that holds nothing but gas. Type the key into the
   shell without echo, so it never lands in the shell history. An unpublished candidate is inert:
   no body can reach it.

   ```bash
   cd back
   read -rs OPERATOR_KEY
   forge create <path to the version>:<contract name> \
     --rpc-url <rpc url> --private-key "$OPERATOR_KEY" --broadcast
   ```

2. Verify its source on the explorer.
3. Read the number it will get, and confirm the code says the same number in `reinitializer(N)`.

   ```bash
   RPC=<rpc url>
   FACTORY=<legalBodyFactory>
   echo $(( $(cast call $FACTORY "versionCount()(uint256)" --rpc-url $RPC) + 1 ))
   ```

4. Rehearse on a fork. This step is required. The factory checks a version's migration number only
   when a body's upgrade executes, after a guardian has signed and waited out the delay, so the
   rehearsal is where a wrong number is caught in time.
   The rehearsal publishes the candidate the way the admin will, creates fresh
   bodies, moves them to the candidate with a guardian's signature, and checks each body's version,
   counter, guardian, delay, manager and identity, then an amendment and a dissolution on the new
   code. Nothing is broadcast. It must end with no failed test.

   ```bash
   FOUNDRY_EVM_VERSION=shanghai \
   REHEARSAL_RPC_URL=$RPC \
   REHEARSAL_FACTORY=$FACTORY \
   REHEARSAL_EXECUTOR=<executor address> \
   REHEARSAL_IMPLEMENTATION=<candidate address> \
     forge test --match-contract LegalBodyReleaseRehearsalTest -vv
   ```

   To rehearse before the candidate is deployed, build it with `forge build` and replace
   `REHEARSAL_IMPLEMENTATION` with `REHEARSAL_CANDIDATE=out/<file>.sol/<contract name>.json`.
   Rehearse the deployed address as well before the ceremony: it is the code bodies will run.

   | Rehearsal result | Meaning |
   |---|---|
   | `MigrationNumberMismatch(version, initialized)` | The migration's number is not the number the factory lists the candidate under, or the migration does not count itself. Fix `reinitializer(N)`. |
   | `FailedCall()` | The candidate has no `migrate`. A migration that reverts shows its own error instead. |
   | `break-glass ceremony did not succeed` | The factory refused to list the candidate: it has no code, it is already listed, or it is not a locked UUPS logic contract. |
   | A failed assertion naming the guardian, the delay, the manager or the identity | The migration changed something a guardian did not agree to. |

5. Tell the person on call. The monitor raises `controller_role_granted` as critical when the admin
   grants the helper its role, because no standing grant covers a release selector. During a
   ceremony that alert is expected once, and the same transaction that acts also revokes the role.
6. Publish the announcement prepared for guardians: what the version changes, and that nothing
   happens to a body unless its guardian signs.

## Publish

Two people can share this: an operator with the throwaway key of "Before the ceremony", and the
admin with the cold key.

1. The operator builds the call and deploys the helper. Only the address that deploys the helper
   can fire it.

   ```bash
   CONTROLLER=<noviController>
   VERSION=<candidate address>
   CALLDATA=$(cast calldata "publishVersion(address)" $VERSION)
   forge create src/BreakGlassOneShot.sol:BreakGlassOneShot \
     --rpc-url $RPC --private-key "$OPERATOR_KEY" --broadcast \
     --constructor-args $CONTROLLER $FACTORY $CALLDATA
   HELPER=<the address it prints>
   ```

2. The admin checks the helper before granting anything. All four must match.

   ```bash
   cast call $HELPER "controller()(address)" --rpc-url $RPC   # the controller
   cast call $HELPER "target()(address)" --rpc-url $RPC       # the factory
   cast call $HELPER "selector()(bytes4)" --rpc-url $RPC      # cast sig "publishVersion(address)"
   cast call $HELPER "callData()(bytes)" --rpc-url $RPC       # $CALLDATA, ending in the candidate's address
   ```

3. The admin grants the helper the selector's role, from the cold key.

   ```bash
   ROLE=$(cast to-bytes32 $(cast sig "publishVersion(address)"))
   cast send $CONTROLLER "grantRole(bytes32,address)" $ROLE $HELPER --rpc-url $RPC --ledger
   ```

4. The operator fires the helper.

   ```bash
   cast send $HELPER "execute()" --rpc-url $RPC --private-key "$OPERATOR_KEY"
   ```

5. Read the result. `execute` does not revert when the relayed call fails, so the transaction's
   status is not the result. Read the chain.

   ```bash
   cast call $FACTORY "versionCount()(uint256)" --rpc-url $RPC                 # one more than before
   cast call $FACTORY "versionInfo(uint256)((address,uint64,bool,bytes32))" \
     <the new version number> --rpc-url $RPC                                   # the candidate, then false: not withdrawn
   cast call $CONTROLLER "hasRole(bytes32,address)(bool)" $ROLE $HELPER --rpc-url $RPC   # false
   cast call $HELPER "used()(bool)" --rpc-url $RPC                             # true
   ```

   If the count did not move, the relayed call failed. The helper is spent and the role is already
   revoked. The `BreakGlassExecuted` event of the `execute` transaction carries the factory's
   revert data. Fix the cause and start again from step 1 with a new helper.

6. Record the version: its number, its address, the transaction and the date, next to the
   deployment's addresses.
7. Clear the key from the shell with `unset OPERATOR_KEY`.

## Withdraw

The ceremony is the same with another call. Withdraw as soon as a published version is found to be
wrong: a body cannot be moved to a withdrawn version, even by an upgrade already scheduled.

```bash
CALLDATA=$(cast calldata "withdrawVersion(uint256)" <version number>)
ROLE=$(cast to-bytes32 $(cast sig "withdrawVersion(uint256)"))
```

Deploy a new helper with that `CALLDATA`, check it, grant it `ROLE`, fire it, then read:

```bash
cast call $FACTORY "versionInfo(uint256)((address,uint64,bool,bytes32))" \
  <version number> --rpc-url $RPC                                             # the third value is true: withdrawn
cast call $CONTROLLER "hasRole(bytes32,address)(bool)" $ROLE $HELPER --rpc-url $RPC   # false
```

A corrected version is published as a new version, under the next number. Its migration must carry
the steps of the withdrawn one for bodies that never took it, and must not repeat them for bodies
that did.

## What a guardian then does

Publishing ends the release. A body moves only when its guardian acts:

1. The guardian signs the typed message
   `LegalBodyUpgrade(address legalBody,uint256 version,address implementation,uint256 nonce,uint256 deadline)`
   for the factory's EIP-712 domain. `upgradeDigest` returns the digest, and `upgradeNonce(body)`
   the nonce.
2. Anyone sends it with `scheduleLegalBodyUpgrade`. The body's own delay starts.
3. During the delay the guardian can cancel, with `cancelLegalBodyUpgrade` or with a signed
   `LegalBodyUpgradeCancel` message that anyone may send through `cancelLegalBodyUpgradeBySig`.
   Either cancel uses up the body's upgrade nonce: every upgrade signature the guardian made
   before it is void, sent or not.
4. After the delay, and for 30 days, anyone can call `executeLegalBodyUpgrade`.

Read a body's state with `versionOf(body)`, `pendingUpgrade(body)` and `bodyRecord(body)` on the
factory, and `initializedVersion()` on the body.

## If something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| `execute` succeeded and `versionCount()` did not move | The factory refused the candidate | Read the `BreakGlassExecuted` revert data, fix the cause, new helper |
| `NotGranted()` when firing the helper | The admin has not granted the role, or granted another helper | The helper is unspent: grant it, then fire |
| `VersionExists(address)` | That address is already on the list | Nothing to publish |
| A body's upgrade reverts with `MigrationNumberMismatch` after publishing | The rehearsal was skipped or ran against other code | Withdraw the version, publish a corrected one |
| The helper still holds its role after `execute` | The ceremony did not complete | The admin revokes the role now: `revokeRole(bytes32,address)` |
| A grant of a release selector that no ceremony explains | Not ours | The admin revokes it at once and reviews every `VersionPublished` and `VersionWithdrawn` since |
