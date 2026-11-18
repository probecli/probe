#!/usr/bin/env bash
# First real PROBE job on Robinhood Chain mainnet, run from your own terminal.
#
#   bash scripts/first-job.sh
#
# What it does, end to end, with real money on mainnet:
#   1. Sponsor (your probe-owner keystore) funds a job with BUDGET ETH in ProbeJobs
#      and registers the spec with the live verifier.
#   2. Operator (your own operator key in ~/.probe, created if missing) runs the job's
#      seed cases with the CLI and submits the ones that pass.
#   3. The live verifier reproduces them and settles accepted cases on-chain.
#   4. The operator receives a little gas from the sponsor and withdraws the reward.
#
# Every step leaves a public transaction, which is the evidence anyone can check.
# The key is decrypted into this process only after a password prompt; it is never
# printed or saved.
set -euo pipefail

VERIFIER_URL="${VERIFIER_URL:-https://verifier.probecli.com}"
RPC="${RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
CHAIN_ID=4663
BUDGET="${BUDGET:-0.002}"      # ETH funded into the job
REWARD="${REWARD:-0.0002}"     # ETH per accepted case
DAYS="${DAYS:-30}"
GAS_TOPUP="${GAS_TOPUP:-0.0002}" # ETH sent to the operator so it can withdraw
SLUG="${SLUG:-scheduled-exit-fee-withdrawals}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
probe() { node "$ROOT/protocol/bin/probe.mjs" "$@"; }

[ "$(cast chain-id --rpc-url "$RPC")" = "$CHAIN_ID" ] || { echo "RPC is not Robinhood Chain mainnet"; exit 1; }
curl -sf "$VERIFIER_URL/health" >/dev/null || { echo "Verifier at $VERIFIER_URL is not answering"; exit 1; }

echo "== Unlocking probe-owner (sponsor for this first job)"
SPONSOR_KEY="$(cast wallet decrypt-keystore probe-owner 2>/dev/null | awk '{print $NF}' | grep -E '^0x[0-9a-fA-F]{64}$')" \
  || { echo "Could not unlock probe-owner"; exit 1; }
SPONSOR="$(cast wallet address --private-key "$SPONSOR_KEY")"
echo "   sponsor $SPONSOR, balance $(cast balance "$SPONSOR" --ether --rpc-url "$RPC") ETH"
echo "   job $SLUG: budget $BUDGET ETH, $REWARD ETH per accepted case, open $DAYS days"
read -r -p "Fund this job on mainnet? [y/N] " ok
[ "$ok" = "y" ] || { echo "Stopped. Nothing was sent."; exit 0; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
python3 - "$ROOT/jobs/scheduled-exit-fee/job.json" "$WORK/job.json" "$SLUG" <<'PY'
import json, sys
spec = json.load(open(sys.argv[1]))
spec["slug"] = sys.argv[3]
spec["network"] = {"id": "robinhood-chain", "name": "Robinhood Chain"}
spec["sponsor"] = "PROBE team (first job, funded to prove the full loop on mainnet)"
json.dump(spec, open(sys.argv[2], "w"), indent=2)
PY

export PROBE_VERIFIER_URL="$VERIFIER_URL" PROBE_REPO_ROOT="$ROOT" RPC_URL="$RPC"

echo "== 1. Sponsor: fund and register (report key kept in ~/.probe-sponsor)"
PROBE_HOME="$HOME/.probe-sponsor" PROBE_SPONSOR_KEY="$SPONSOR_KEY" probe sponsor keygen
PROBE_HOME="$HOME/.probe-sponsor" PROBE_SPONSOR_KEY="$SPONSOR_KEY" \
  probe sponsor create --spec "$WORK/job.json" --token 0x0000000000000000000000000000000000000000 \
  --reward "$REWARD" --budget "$BUDGET" --days "$DAYS"

echo "== 2-3. Operator: run seed cases and submit what passes (key in ~/.probe)"
[ -f "$HOME/.probe/config.json" ] || probe init
probe work "$SLUG" --no-agent
probe balance "$SLUG"

echo "== 4. Operator: withdraw"
OPERATOR="$(cast wallet address --private-key "$(node -e 'console.log(require(process.env.HOME+"/.probe/config.json").operatorKey??"")')" 2>/dev/null || true)"
if [ -n "$OPERATOR" ]; then
  cast send "$OPERATOR" --value "${GAS_TOPUP}ether" --rpc-url "$RPC" --private-key "$SPONSOR_KEY" >/dev/null
  probe withdraw "$SLUG" || echo "Withdraw later with: probe withdraw $SLUG"
else
  echo "Could not read the operator address; withdraw later with: probe withdraw $SLUG"
fi

echo
echo "Done. See the job at https://probecli.com/jobs/$SLUG and the numbers on /contracts and /status."
