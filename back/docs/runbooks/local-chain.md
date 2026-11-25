# Runbook: a local chain for the legal-body screens

*2026-11-17, updated 2026-11-25. For working on the legal-body screens against a backend on
today's contracts, on your own machine, without touching the testnet box.*

## What it gives you

- **A local copy of Arc testnet** (an anvil fork), taken when the chain starts, on
  `http://127.0.0.1:8555`. It reads Arc testnet's state at that moment and never writes to it. The
  ERC-8004 registries are there, and so is every agent identity that existed on Arc testnet then,
  owned by the same wallets.
- **Today's Minimal Novi contracts deployed on it** (`back/script/DeployMinimal.s.sol`), with
  fresh keys made for this chain only.
- **The settings the API needs to run against them**, with the agreement set to the October texts
  (`LEGAL_BODY_AGREEMENT_VERSION=2026-10-draft-1`).

**The Legal Body Charter.** A Charter text states facts of the legal body's contract, and at start
the API proves them on the chain it is given. The Charter draft the backend holds today
(`2026-11-draft-5`) is written for legal bodies whose code is never replaced. Today's contracts
create legal bodies that can be upgraded, so with that draft the API refuses to start here, and
its message says why. The Charter runs on this chain once the backend serves a Charter draft
written for upgradeable legal bodies; this script's default then moves to it.

Everything stays on your machine.

## What you need

- Foundry `v1.5.1` (`anvil`, `forge`, `cast` on your `PATH`; the version CI pins) and Node 22.
- `back/lib`: run the three `forge install` lines of [`back/README.md`](../../README.md) in `back/`
  once, if you have never built the contracts.
- `npm install` done in `back/backend` and in `interface`.
- **World ID sandbox**, because the company doors and the grant doors need a verified human
  behind the Guardian: the World ID (Sandbox) app on your phone and the three portal values. Both
  are described in [`world-sandbox-testing.md`](world-sandbox-testing.md).

## Once

1. Write `back/backend/.env.local-chain` (git ignores it) with the World ID block:

   ```bash
   WORLD_APP_ID=app_...
   WORLD_RP_ID=rp_...
   WORLD_RP_SIGNING_KEY=...
   WORLD_ENVIRONMENT=sandbox
   WORLD_ACTION=guardian-sandbox
   ```

   The script adds this file to the API's settings at every start. Without it the API still
   starts, and the company and grant doors answer `503` "human verification is not configured on
   this deployment". Anything else you want the local API to have goes in the same file.

2. Point the interface's chain reads at the local chain: in `interface/.env.local` (git ignores
   it), set

   ```bash
   NEXT_PUBLIC_ARC_RPC_URL=http://127.0.0.1:8555
   ```

   The interface's `/backend` proxy already goes to `http://localhost:8789` in development, and
   its sign-in domain (`localhost`) is the API's default, so nothing else changes.

## Each session

```bash
cd back/backend
scripts/local-chain.sh up      # about 10 seconds
npm run api:local              # http://localhost:8789; leave it running

# in a second terminal
cd interface
npm run dev                    # http://localhost:3000
```

When the API is ready, its start prints these lines among others:

```
[boot] legal texts: agreement 2026-10-draft-1 (draft), declaration 2026-10-draft-1 (draft)
[boot] legal-body factory wiring verified on-chain: owner, registry, typed-data domain on chain 5042002, 2 pinned executor grants
Wizard API listening on :8789
```

To stop: `Ctrl-C` the API, then `scripts/local-chain.sh down`. `scripts/local-chain.sh status`
says whether a chain is up and what was deployed.

**Every `up` starts from nothing**: a new chain, new keys, new contracts and an empty database.
The API stores the controller it first verified and refuses another one later, so the database of
an earlier run cannot be kept. Sign in again, verify again and declare again after each `up`. If
World's sandbox refuses a second verification of the same identity for the same action, reset the
sandbox identity in the app, as [`world-sandbox-testing.md`](world-sandbox-testing.md) describes.

## The flow on the local chain

The same doors as on the testnet box:

1. **Sign in** with your wallet, then **verify** with the World ID (Sandbox) app.
2. **Declare a test company.** The local API is a sandbox: the name must say it is a test
   (`Local Test Holdings LLC`), the filing number is a test number (`TEST-` then 4 to 27 of A-Z,
   0-9 and hyphens), the declaration is `synthetic: true`, and the company is checked
   automatically. On a Charter deployment the statement answer carries `adoptionRule`.
3. **Order.** On a Charter deployment the order takes a grant (`GET /legal-body-orders/grant-form`
   serves the form and the `notice`); on the October texts it takes none.
4. **Read the agreement.** On a Charter deployment `notice` and `adoptionStatement` are set.
5. **Adopt.** The adoption message is served in the form the agreement calls for
   (`OperatingAgreementAdoption`, or `LegalBodyCharterAdoption` with its `statement`).
6. **Give the agent a wallet of its own.** The link is refused (`409 agent_wallet_required`) while
   the agent's identity names no wallet, or names the Guardian's. An identity registered from your
   own wallet names your wallet, so set the agent's own wallet first: the website's legal-body
   flow has a step for it, or call the registry's `setAgentWallet` (the new wallet signs
   `AgentWalletSet`, and the identity's owner sends it).
7. **Link** an agent identity you own. The legal body is created on the local chain, through the
   local controller.

**Your wallet.** In this flow the Guardian only signs (sign-in, declaration, adoption, link), and
the API sends every transaction. A wallet set to Arc testnet signs for the local chain too,
because the chain id is the same (5042002). To send a transaction to the local chain yourself
(registering a new agent identity, for example), add a network to your wallet with the RPC
`http://127.0.0.1:8555` and chain id 5042002, and give your address gas:

```bash
cast rpc --rpc-url http://127.0.0.1:8555 anvil_setBalance <your address> 0x56BC75E2D63100000
```

An agent identity created on Arc testnet after the chain started is not on the local chain.

## Other texts

To choose the texts, set `LOCAL_CHAIN_AGREEMENT_VERSION` for `up`, for example:

```bash
LOCAL_CHAIN_AGREEMENT_VERSION=2026-11-draft-5 scripts/local-chain.sh up
```

On today's contracts the API then refuses to start, as said above. That Charter draft runs on a
checkout from before the upgradeable legal body was merged.

## What `up` does

1. Refuses if a chain it started is still running, or if the port is taken.
2. Deletes `back/backend/.local-chain/` and starts anvil as a fork of Arc testnet, chain id
   5042002, on port 8555, making a block every second. The API refuses a chain whose latest block
   is too old, and a chain that made blocks only on transactions would look stalled after a few
   quiet minutes (`503 chain_unavailable`).
3. Creates four keys (deployer, admin, executor, operator) with `cast wallet new`, writes them to
   `.local-chain/keys.env` with owner-only permissions, and gives each gas. It never prints a key.
4. Runs `DeployMinimal.s.sol` with the deployer key, the admin and the executor: a LegalManager
   implementation, a LegalBodyFactory owned by a NoviController, and the controller with the two
   legal-body grants to the executor.
5. Reads the three addresses, and the transaction and block that created the controller, from the
   deploy's broadcast record and its receipts.
6. Writes `.local-chain/api.env` (the chain, the keys, the addresses, the texts, a database in
   `.local-chain/data`), then adds `back/backend/.env.local-chain` if you wrote one.

`npm run api:local` is `npm run api` with `DOTENV_CONFIG_PATH=.local-chain/api.env`.

## When something goes wrong

| What you see | What to do |
|---|---|
| `port 8555 is taken` | Something else listens there. Set `LOCAL_CHAIN_PORT` to a free port for `up` and `status`, and use the same port in `interface/.env.local`. Port 8545 is left to the backend's tests. |
| `a chain is already running` | `scripts/local-chain.sh down`, then `up`. |
| `the chain did not answer in 60 seconds` | Arc testnet's public RPC did not answer the fork. See `.local-chain/anvil.log`, or set `LOCAL_CHAIN_FORK_URL` to another Arc testnet RPC. |
| `the deploy failed` | See `.local-chain/deploy.log`. A missing `back/lib` shows there as a missing import. |
| The API refuses to start with a `boot:` or `Invalid config:` line | The line names the check. After a failed `up`, run `up` again. |
| `503` "human verification is not configured on this deployment" | `back/backend/.env.local-chain` is missing or lacks the World ID block. Write it, then `up` again. |

The deploy writes its broadcast record to `back/broadcast/DeployMinimal.s.sol/5042002/` (git
ignores it), the folder a real Arc testnet deploy from the same checkout uses, since the chain id
is the same. If you also deploy to Arc testnet from this checkout, keep that run's record
elsewhere first.
