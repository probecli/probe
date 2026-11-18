#!/usr/bin/env bash
# Rebuild ProbeJobs from contracts/ and compare it with the code deployed on each network
# in deployments/robinhood-chain.json. Exits non-zero on any mismatch.
#
#   scripts/verify-bytecode.sh            # mainnet and testnet
#   scripts/verify-bytecode.sh mainnet    # one network
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
deployments="$root/deployments/robinhood-chain.json"
networks=("${@:-mainnet testnet}")
read -r -a networks <<< "${networks[*]}"

command -v forge >/dev/null || { echo "forge not found: install Foundry from https://getfoundry.sh" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq not found" >&2; exit 2; }

(cd "$root/contracts" && forge build --force --silent)
built="$(jq -r .deployedBytecode.object "$root/contracts/out/ProbeJobs.sol/ProbeJobs.json" | tr 'A-F' 'a-f')"

status=0
for net in "${networks[@]}"; do
  address="$(jq -r ".${net}.ProbeJobs" "$deployments")"
  rpc="$(jq -r ".${net}.rpc" "$deployments")"
  if [[ "$address" == "null" || "$rpc" == "null" ]]; then
    echo "$net: not in $deployments" >&2; status=1; continue
  fi
  onchain="$(cast code "$address" --rpc-url "$rpc" | tr 'A-F' 'a-f')"
  if [[ "$onchain" == "0x" ]]; then
    echo "$net: no code at $address" >&2; status=1
  elif [[ "$onchain" == "$built" ]]; then
    echo "$net: $address matches contracts/ ($(( (${#built} - 2) / 2 )) bytes)"
  else
    echo "$net: $address does NOT match contracts/" >&2; status=1
  fi
done
exit $status
