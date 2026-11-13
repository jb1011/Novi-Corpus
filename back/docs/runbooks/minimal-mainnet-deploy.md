# Runbook — Minimal Novi mainnet deploy

Last revised: 2026-11-10

Script: `back/script/DeployMinimal.s.sol` · tests: `back/test/DeployMinimal.t.sol` (local) and
`back/test/DeployMinimalFork.t.sol` (live Arc testnet) · addresses: `back/addresses.arc-mainnet.json`.

## What gets deployed

One `forge script` broadcast sends three contract creations from a throwaway deployer, in this order:

| Order | Contract | Constructed with | Ends up |
|---|---|---|---|
| 1 | `LegalManager` | nothing | The locked implementation every legal body clones. |
| 2 | `LegalBodyFactory` | the implementation, the identity registry, the controller's predicted address | Owned by the controller from construction, with no pending owner. |
| 3 | `NoviController` | admin delay, admin, executor, the two legal-body selectors, both pinned to the factory | The executor may relay `createLegalBody` and `scheduleOperatingAgreementUpdate` to the factory, and nothing else. |

No admin transaction follows: there is no `acceptOwnership`, no pin ceremony and no break-glass.
No contract in this deploy holds funds. The deployer holds no role once the script finishes.

The script refuses to run, and a dry run reverts before anything is sent, when any of these fails:

| Check | Refusal message |
|---|---|
| `CHAIN_ID` equals the connected chain | `CHAIN_ID does not match the connected chain` |
| The chain has a pinned registry (Arc mainnet or Arc testnet) | `no identity registry is pinned for this chain` |
| `IDENTITY_REGISTRY` equals that pinned registry | `IDENTITY_REGISTRY is not the registry pinned for this chain` |
| The registry has code | `IDENTITY_REGISTRY is not a contract` |
| Admin and executor are set and differ | `admin and executor are required`, `admin and executor must differ` |
| The deployer is neither admin nor executor | `the deployer must hold no role` |
| On Arc mainnet, the admin delay is at least 1 hour | `CONTROLLER_ADMIN_DELAY is under 1 hour` |
| On Arc mainnet, the admin delay is at most 30 days | `CONTROLLER_ADMIN_DELAY is over 30 days (a value in milliseconds?)` |

A zero delay lets a mistaken or stolen admin key hand the role over at once. An oversized delay
takes as long to shorten as it is long, because the controller waits out the difference before a
shorter delay applies. Arc testnet keeps no bound.

## Preconditions

1. **Prove the hardware wallet signs on Arc mainnet.** From the admin address on the hardware
   wallet, send one zero-value transaction to itself on Arc mainnet (chain id 5042). The gas token
   is USDC, so the address needs a little USDC first. Confirm the transaction on the explorer.
   This address becomes the controller's only admin, so prove it signs before it holds anything.
2. **Check the chain and the registry.**

   ```bash
   cast chain-id --rpc-url <arc mainnet rpc url>          # 5042
   cast code 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 --rpc-url <arc mainnet rpc url>   # non-empty
   ```

3. **Have the three keys ready.**

   | Key | Role after the deploy | Where it lives |
   |---|---|---|
   | Deployer | None. It pays for three creations and is then retired. | A fresh throwaway key, funded with about 1 USDC. |
   | Admin | `DEFAULT_ADMIN_ROLE` on the controller: grants, revokes, pins. | The hardware wallet from step 1. |
   | Executor | The two legal-body selector roles. | The production backend key; only its address is needed here. |

   Use a fresh deployer: the Arc RPC refuses well-known development accounts, and a reused key
   could already hold a role somewhere.
4. **Build the commit you deploy.** From a clean checkout, run `forge build` in `back/` with the
   repo's own `foundry.toml`. Do not set `FOUNDRY_EVM_VERSION`: the repo pins its deploy EVM
   version there, and another version produces different bytecode from the one the tests ran on.
5. **Have a backend build with the Minimal-only boot mode.** The mainnet box runs the legal-body
   product only, so its configuration names a controller, a legal-body factory and the
   controller's deployment transaction, and no full-product factory. Confirm the backend release
   you deploy documents `CONTROLLER_DEPLOY_TX` in its `.env.example` before starting.

## Environment

Type the deployer key into the shell from the password manager. Never paste it into a chat, a
ticket or a file under version control.

```bash
cd back
export PRIVATE_KEY=<deployer key>
export CHAIN_ID=5042
export IDENTITY_REGISTRY=0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
export CONTROLLER_ADMIN=<admin address>
export CONTROLLER_EXECUTOR=<executor address>
# Optional, in seconds. The admin handover delay; defaults to 86400 (24 hours).
# On Arc mainnet it must lie between 3600 (1 hour) and 2592000 (30 days).
# export CONTROLLER_ADMIN_DELAY=86400
```

## Dry run, then broadcast

1. Run the dry run. It simulates all three creations and every post-condition against the live
   chain and sends nothing.

   ```bash
   forge script script/DeployMinimal.s.sol --rpc-url <arc mainnet rpc url>
   ```

2. If it prints a refusal message, fix the input it names and run step 1 again.
3. Read the output. It must show the `Inputs:` block, `All post-conditions hold`, the addresses
   block and `SIMULATION COMPLETE`. Check that the key in the shell is the throwaway deployer, with
   `cast wallet address --private-key $PRIVATE_KEY`, and that it is neither the admin nor the
   executor.
4. Compare the `CONTROLLER_ADMIN` line of the `Inputs:` block with the address on the hardware
   wallet's screen, character by character. Do not broadcast until they match. A typo in the
   executor is recoverable with a role change; a typo in the admin means a redeploy, because no
   one else can ever change the controller's roles.
5. Broadcast.

   ```bash
   forge script script/DeployMinimal.s.sol --rpc-url <arc mainnet rpc url> --broadcast
   ```

6. Clear the key from the shell with `unset PRIVATE_KEY`.

## What the output means, and the explorer checks

`All post-conditions hold` means the script read back, from the deployed contracts:

- The controller sits at the predicted address, and it owns the factory with no pending owner.
- The factory uses the new implementation and the pinned registry.
- Both legal-body selectors are pinned to the factory and granted to the executor, and to no one else.
- None of the seven full-product selectors is granted to the executor or pinned.
- No one holds `WILDCARD_ROLE`.
- `defaultAdmin()` is the admin, with the configured delay and no pending handover; neither the
  deployer nor the executor holds `DEFAULT_ADMIN_ROLE`.

Then check on the explorer:

1. The deployer sent exactly three contract creations, in the order of the table in "What gets
   deployed", and nothing else.
2. The controller's creation transaction emits `RoleGranted` for `DEFAULT_ADMIN_ROLE` to the admin,
   two `RoleGranted` for the selector roles to the executor, and two `BoundTargetSet` naming the
   factory.
3. Read the wiring back independently of the script.

   ```bash
   RPC=<arc mainnet rpc url>
   CONTROLLER=<noviController>
   FACTORY=<legalBodyFactory>
   cast call $FACTORY "owner()(address)" --rpc-url $RPC            # the controller
   for SIG in "createLegalBody(uint256,address,uint256,bytes32,uint256,bytes)" \
              "scheduleOperatingAgreementUpdate(address,bytes32,uint256,bytes)"; do
     SEL=$(cast sig "$SIG")
     cast call $CONTROLLER "boundTarget(bytes4)(address)" $SEL --rpc-url $RPC            # the factory
     cast call $CONTROLLER "hasRole(bytes32,address)(bool)" \
       $(cast to-bytes32 $SEL) <executor address> --rpc-url $RPC                        # true
   done
   cast call $CONTROLLER "defaultAdmin()(address)" --rpc-url $RPC   # the admin
   ```

4. Verify the three contracts' source on the explorer.

## Record the deployment

1. Fill `back/addresses.arc-mainnet.json` from the printed block: `legalManagerImpl`,
   `legalBodyFactory`, `noviController`. Fill `rpc`, `explorer` and `updatedAt` too.
2. Take `controllerDeployBlock` from the controller's receipt, not from the printed block. The
   printed value is the simulated block, which is never later than the real one.

   ```bash
   TX=$(jq -r '.transactions[] | select(.contractName=="NoviController") | .hash' \
     broadcast/DeployMinimal.s.sol/5042/run-latest.json)
   echo $TX
   cast receipt $TX blockNumber --rpc-url <arc mainnet rpc url>
   ```

3. Set the backend environment for the mainnet box. Leave `FACTORY_ADDRESS` unset: there is no
   full-product factory on mainnet, and the backend's Minimal-only mode is the one that boots
   without it.

   ```bash
   LEGAL_BODY_FACTORY_ADDRESS=<legalBodyFactory>
   CONTROLLER_ADDRESS=<noviController>
   CONTROLLER_DEPLOY_TX=<the transaction hash from step 2>
   # FACTORY_ADDRESS stays unset
   ```

   Boot reads the receipt of `CONTROLLER_DEPLOY_TX`, refuses unless it created exactly
   `CONTROLLER_ADDRESS`, and starts the `WILDCARD_ROLE` ledger at its block, so the hash is the
   proof of where the role history begins.
4. Keep the controller's deployment transaction hash and block next to the addresses in the
   addresses file.

## Testnet dress rehearsal

Run the same script on Arc testnet before mainnet, with fresh keys for all three roles, and follow
every section of this runbook with these values:

```bash
export CHAIN_ID=5042002
export IDENTITY_REGISTRY=0x8004A818BFB912233c491871b3d84c89A494BD9e
export ARC_TESTNET_RPC_URL=<arc testnet rpc url>   # foundry.toml's arc_testnet endpoint reads it
forge script script/DeployMinimal.s.sol --rpc-url arc_testnet               # dry run
forge script script/DeployMinimal.s.sol --rpc-url arc_testnet --broadcast
```

The rehearsal deploys a new controller, factory and implementation at new addresses. It never
calls the testnet controller the testnet box uses, which stays untouched, as do its factory and
its bodies. Record the rehearsal addresses apart from the ones in use, and write down every
deviation from this runbook so the mainnet run does not meet it for the first time.

## Rollback

- **Replace the factory.** The admin can call `setBoundTarget` on the controller for both
  legal-body selectors, naming a replacement factory owned by the same controller. The executor's
  grants stay; from that transaction on, the executor reaches only the replacement. Bodies created
  by the old factory keep their status, their pointer and their guardian's veto and dissolve, and
  an amendment already scheduled on one still executes. The executor can no longer schedule new
  amendments on them, so a factory replacement is a migration notice to every guardian.
- **Re-key a role.** The admin can revoke and grant the selector roles, and hand the admin role
  over after the admin delay.
- **Nothing else is reversible.** The implementation, the factory's registry and implementation,
  and the controller's code are fixed. A wrong registry or implementation needs a new deploy.
  No contract in this deploy holds funds, so nothing needs recovering.
