#!/usr/bin/env bash
# A local chain for trying the legal-body screens: a local copy of Arc testnet, today's Minimal
# Novi contracts deployed on it, and the settings the API needs to run against them.
#
#   scripts/local-chain.sh up     start the chain, deploy, write .local-chain/api.env
#   scripts/local-chain.sh down   stop the chain
#   scripts/local-chain.sh status say whether the chain is up and what was deployed
#
# Then start the API with `npm run api:local`. Run from back/backend. See
# back/docs/runbooks/local-chain.md.
#
# Every `up` starts from nothing: a new chain, new keys, new contracts and an empty database. The
# API stores the controller it first verified and refuses another one later, so the database of an
# earlier run cannot be kept.
#
# The keys are created here, used only on this chain, and written to .local-chain/ (git-ignored)
# with owner-only permissions. Nothing here prints a key.
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="$(cd "$BACKEND_DIR/.." && pwd)"
STATE_DIR="$BACKEND_DIR/.local-chain"

PORT="${LOCAL_CHAIN_PORT:-8555}"
FORK_URL="${LOCAL_CHAIN_FORK_URL:-https://rpc.testnet.arc.network}"
RPC_URL="http://127.0.0.1:$PORT"
CHAIN_ID=5042002
IDENTITY_REGISTRY=0x8004A818BFB912233c491871b3d84c89A494BD9e
AGREEMENT_VERSION="${LOCAL_CHAIN_AGREEMENT_VERSION:-2026-11-draft-5}"
# Your own settings, added to the API's after the chain's (the World ID block goes here). Kept
# outside .local-chain/ so that `up` does not delete it; git ignores it (.env.*).
EXTRA_ENV="${LOCAL_CHAIN_EXTRA_ENV:-$BACKEND_DIR/.env.local-chain}"
# 100 of the chain's native unit, for gas.
FUNDING=0x56BC75E2D63100000

say() { printf 'local-chain: %s\n' "$*"; }
fail() {
  printf 'local-chain: %s\n' "$*" >&2
  exit 1
}

need_tools() {
  local tool
  for tool in anvil forge cast node; do
    command -v "$tool" >/dev/null || fail "$tool is not on PATH (Foundry gives anvil, forge and cast)"
  done
  local lib
  for lib in forge-std openzeppelin-contracts openzeppelin-contracts-upgradeable; do
    [ -d "$CONTRACTS_DIR/lib/$lib" ] ||
      fail "back/lib/$lib is missing: run the three forge install lines of back/README.md in back/ first"
  done
}

chain_pid() {
  [ -f "$STATE_DIR/anvil.pid" ] || return 1
  local pid
  pid="$(cat "$STATE_DIR/anvil.pid")"
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$pid"
}

down() {
  local pid
  if pid="$(chain_pid)"; then
    kill "$pid"
    say "chain stopped"
  else
    say "no chain running"
  fi
  rm -f "$STATE_DIR/anvil.pid"
}

new_key() {
  # Appends NAME_ADDRESS and NAME_PRIVATE_KEY to keys.env, never to the terminal.
  cast wallet new --json | NAME="$1" node -e '
    const [w] = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    process.stdout.write(`${process.env.NAME}_ADDRESS=${w.address}\n${process.env.NAME}_PRIVATE_KEY=${w.private_key}\n`);
  ' >>"$STATE_DIR/keys.env"
}

created() {
  # The address of contract $2 in broadcast record $1, or ($3 = hash or block) the transaction
  # that created it. The transaction is read from the receipts, which name the contract each one
  # created: the hashes in the record's list of transactions can be out of step with it when two
  # creations land in the same block.
  node -e '
    const [file, name, field] = process.argv.slice(1);
    const run = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
    const tx = run.transactions.find((t) => t.transactionType === "CREATE" && t.contractName === name);
    if (!tx || !tx.contractAddress) process.exit(1);
    if (field === "address") {
      process.stdout.write(tx.contractAddress);
      process.exit(0);
    }
    const rc = run.receipts.find((r) => (r.contractAddress ?? "").toLowerCase() === tx.contractAddress.toLowerCase());
    if (!rc || BigInt(rc.status) !== 1n) process.exit(1);
    process.stdout.write(field === "hash" ? rc.transactionHash : BigInt(rc.blockNumber).toString());
  ' "$1" "$2" "$3"
}

up() {
  need_tools
  chain_pid >/dev/null && fail "a chain is already running (scripts/local-chain.sh down first)"
  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    fail "port $PORT is taken; set LOCAL_CHAIN_PORT to a free one"
  fi

  rm -rf "$STATE_DIR"
  umask 077
  mkdir -p "$STATE_DIR/data"

  say "starting a local copy of Arc testnet on $RPC_URL"
  # A block every second: the API refuses a chain whose latest block is too old, and a chain
  # that mines only on transactions looks stalled after a few quiet minutes.
  anvil --fork-url "$FORK_URL" --chain-id "$CHAIN_ID" --port "$PORT" --block-time 1 >"$STATE_DIR/anvil.log" 2>&1 &
  printf '%s' "$!" >"$STATE_DIR/anvil.pid"
  local tries=0
  until cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -lt 60 ] || fail "the chain did not answer in 60 seconds (see .local-chain/anvil.log)"
    chain_pid >/dev/null || fail "the chain stopped at start (see .local-chain/anvil.log)"
    sleep 1
  done

  say "creating the deployer, admin, executor and operator keys"
  : >"$STATE_DIR/keys.env"
  new_key DEPLOYER
  new_key ADMIN
  new_key EXECUTOR
  new_key OPERATOR
  # shellcheck disable=SC1091
  source "$STATE_DIR/keys.env"
  local who
  for who in "$DEPLOYER_ADDRESS" "$ADMIN_ADDRESS" "$EXECUTOR_ADDRESS" "$OPERATOR_ADDRESS"; do
    cast rpc --rpc-url "$RPC_URL" anvil_setBalance "$who" "$FUNDING" >/dev/null
  done

  say "deploying the Minimal Novi contracts"
  (
    cd "$CONTRACTS_DIR"
    PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" CHAIN_ID="$CHAIN_ID" IDENTITY_REGISTRY="$IDENTITY_REGISTRY" \
      CONTROLLER_ADMIN="$ADMIN_ADDRESS" CONTROLLER_EXECUTOR="$EXECUTOR_ADDRESS" \
      forge script script/DeployMinimal.s.sol --rpc-url "$RPC_URL" --broadcast --skip test -j 1 \
      >"$STATE_DIR/deploy.log" 2>&1
  ) || fail "the deploy failed (see .local-chain/deploy.log)"

  local run="$CONTRACTS_DIR/broadcast/DeployMinimal.s.sol/$CHAIN_ID/run-latest.json"
  [ -f "$run" ] || fail "the deploy wrote no broadcast record ($run)"
  cp "$run" "$STATE_DIR/deploy.json"
  local factory controller controller_tx controller_block
  factory="$(created "$run" LegalBodyFactory address)" &&
    controller="$(created "$run" NoviController address)" &&
    controller_tx="$(created "$run" NoviController hash)" &&
    controller_block="$(created "$run" NoviController block)" ||
    fail "the broadcast record does not name the factory and the controller (see .local-chain/deploy.json)"
  factory="$(cast to-check-sum-address "$factory")"
  controller="$(cast to-check-sum-address "$controller")"

  cat >"$STATE_DIR/api.env" <<EOF
# Written by scripts/local-chain.sh up. Every value is for the local chain only.
ARC_TESTNET_RPC_URL=$RPC_URL
ARC_CHAIN_ID=$CHAIN_ID
IDENTITY_REGISTRY=$IDENTITY_REGISTRY
PLATFORM_PRIVATE_KEY=$EXECUTOR_PRIVATE_KEY
OPERATOR_PRIVATE_KEY=$OPERATOR_PRIVATE_KEY
CONTROLLER_ADDRESS=$controller
CONTROLLER_DEPLOY_TX=$controller_tx
CONTROLLER_DEPLOY_BLOCK=$controller_block
LEGAL_BODY_FACTORY_ADDRESS=$factory
LEGAL_BODY_AGREEMENT_VERSION=$AGREEMENT_VERSION
DATA_DIR=$STATE_DIR/data
EOF
  if [ -f "$EXTRA_ENV" ]; then
    printf '\n# From %s\n' "$EXTRA_ENV" >>"$STATE_DIR/api.env"
    cat "$EXTRA_ENV" >>"$STATE_DIR/api.env"
    say "added your settings from $EXTRA_ENV"
  else
    say "no $EXTRA_ENV: the doors that need World ID answer 503 (see the runbook)"
  fi
  printf 'FACTORY=%s\nCONTROLLER=%s\nCONTROLLER_DEPLOY_BLOCK=%s\n' "$factory" "$controller" "$controller_block" \
    >"$STATE_DIR/addresses.env"

  say "ready: legal-body factory $factory, controller $controller (block $controller_block)"
  say "texts served: $AGREEMENT_VERSION"
  say "next: npm run api:local"
}

status() {
  if chain_pid >/dev/null; then
    say "chain up on $RPC_URL, block $(cast block-number --rpc-url "$RPC_URL")"
    [ -f "$STATE_DIR/addresses.env" ] && sed 's/^/local-chain: /' "$STATE_DIR/addresses.env"
  else
    say "no chain running"
  fi
}

case "${1:-}" in
up) up ;;
down) down ;;
status) status ;;
*) fail "usage: scripts/local-chain.sh up|down|status" ;;
esac
