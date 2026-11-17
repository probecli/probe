#!/usr/bin/env bash
# Full PROBE rehearsal on Robinhood Chain testnet (46630), run from your own terminal.
#
#   bash protocol/scripts/testnet-rehearsal.sh 0x<ProbeJobs testnet address>
#
# Uses the Foundry keystores "probe-owner" and "probe-verifier". Keys are decrypted
# into this process only after a password prompt; they are never printed or saved.
# The owner also acts as the sponsor here, funding the job with a test token (mUSD)
# that this script deploys. A fresh throwaway operator key is generated.
set -euo pipefail

CONTRACT="${1:?Usage: testnet-rehearsal.sh <ProbeJobs testnet address>}"
# REHEARSAL_RPC / REHEARSAL_CHAIN_ID / KEYSTORE_DIR exist only to test this script locally.
RPC="${REHEARSAL_RPC:-https://rpc.testnet.chain.robinhood.com}"
CHAIN_ID="${REHEARSAL_CHAIN_ID:-46630}"
PORT="${VERIFIER_PORT:-8789}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$ROOT/protocol/.data/testnet-$(date +%s)"
export PATH="$HOME/.foundry/bin:$PATH"
mkdir -p "$WORK"

key_of() {
  # decrypt-keystore prints "...private key is: 0x..."; keep only the key.
  cast wallet decrypt-keystore ${KEYSTORE_DIR:+-k "$KEYSTORE_DIR"} "$1" 2>/dev/null | awk '{print $NF}' | grep -E '^0x[0-9a-fA-F]{64}$'
}

echo "== Unlocking keystores (you will be asked for each password)"
OWNER_KEY="$(key_of probe-owner)" || { echo "Could not unlock probe-owner. Run: cast wallet import probe-owner --interactive"; exit 1; }
VERIFIER_KEY="$(key_of probe-verifier)" || { echo "Could not unlock probe-verifier. Run: cast wallet import probe-verifier --interactive"; exit 1; }
OWNER="$(cast wallet address --private-key "$OWNER_KEY")"
VERIFIER="$(cast wallet address --private-key "$VERIFIER_KEY")"
echo "   owner/sponsor $OWNER"
echo "   verifier      $VERIFIER"

[ "$(cast chain-id --rpc-url "$RPC")" = "$CHAIN_ID" ] || { echo "RPC is not chain $CHAIN_ID"; exit 1; }
[ "$(cast call "$CONTRACT" 'approvedVerifier(address)(bool)' "$VERIFIER" --rpc-url "$RPC")" = "true" ] || { echo "$VERIFIER is not approved on $CONTRACT"; exit 1; }

echo "== Deploying a test token (mUSD) and minting 10,000 to the sponsor"
cd "$ROOT/contracts"
USD="$(forge create src/mocks/MockUSD.sol:MockUSD --rpc-url "$RPC" --private-key "$OWNER_KEY" --broadcast 2>&1 | awk '/Deployed to:/ {print $3}')"
[ -n "$USD" ] || { echo "MockUSD deploy failed"; exit 1; }
cast send "$USD" 'mint(address,uint256)' "$OWNER" 10000000000 --rpc-url "$RPC" --private-key "$OWNER_KEY" >/dev/null
echo "   mUSD $USD"

echo "== Starting the verifier against testnet (log: $WORK/verifier.log)"
cd "$ROOT/protocol"
PORT=$PORT HOST=127.0.0.1 RPC_URL="$RPC" CHAIN_ID=$CHAIN_ID PROBE_JOBS_ADDRESS="$CONTRACT" \
  VERIFIER_PRIVATE_KEY="$VERIFIER_KEY" DATA_DIR="$WORK/verifier" JOBS_ROOT="$ROOT" \
  NETWORK_NAME="Robinhood Chain Testnet" EXPLORER_URL="https://explorer.testnet.chain.robinhood.com" \
  node src/verifier/server.ts >"$WORK/verifier.log" 2>&1 &
VPID=$!
trap 'kill $VPID 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 1; done
curl -sf "http://127.0.0.1:$PORT/health" >/dev/null || { echo "Verifier did not start; see $WORK/verifier.log"; exit 1; }

SLUG="rehearsal-exit-fee-$(date +%s)"
python3 - "$ROOT/jobs/scheduled-exit-fee/job.json" "$WORK/job.json" "$SLUG" <<'PY'
import json, sys
spec = json.load(open(sys.argv[1]))
spec["slug"] = sys.argv[3]
spec["network"] = {"id": "robinhood-chain-testnet", "name": "Robinhood Chain Testnet"}
json.dump(spec, open(sys.argv[2], "w"), indent=2)
PY

export PROBE_HOME="$WORK/probe-home" PROBE_VERIFIER_URL="http://127.0.0.1:$PORT" PROBE_REPO_ROOT="$ROOT" RPC_URL="$RPC"
probe() { node "$ROOT/protocol/bin/probe.mjs" "$@"; }

echo "== Sponsor: fund 1,000 mUSD at 100 per accepted case, register the spec"
PROBE_SPONSOR_KEY="$OWNER_KEY" probe sponsor keygen
PROBE_SPONSOR_KEY="$OWNER_KEY" probe sponsor create --spec "$WORK/job.json" --token "$USD" --reward 100 --budget 1000 --days 7

echo "== Operator: probe work (fresh throwaway operator key)"
probe init
probe work "$SLUG" --no-agent --submit-all
probe balance "$SLUG"

echo "== Sponsor: open the private report"
PROBE_SPONSOR_KEY="$OWNER_KEY" probe sponsor reports "$SLUG"

echo
echo "Rehearsal complete. ProbeJobs $CONTRACT, mUSD $USD, job $SLUG."
echo "Verifier log: $WORK/verifier.log"
