#!/usr/bin/env bash
# Deploy the PROBE verifier to your own server (fresh Ubuntu 24.04).
#
#   ./scripts/deploy-verifier.sh <server-ip> <verifier-domain>
#   ./scripts/deploy-verifier.sh 203.0.113.7 verifier.probecli.com
#   ./scripts/deploy-verifier.sh ubuntu@203.0.113.7 verifier.probecli.com   (non-root login)
#
# Run it again any time to ship code changes; the database is kept.
# Before the first run, point an A record for <verifier-domain> at <server-ip>.
set -euo pipefail

TARGET="${1:-}"; DOMAIN="${2:-}"
[[ -n "$TARGET" && -n "$DOMAIN" ]] || { sed -n 2,9p "$0"; exit 1; }
[[ "$TARGET" == *@* ]] || TARGET="root@$TARGET"
IP="${TARGET#*@}"
SUDO=""; [[ "${TARGET%%@*}" == root ]] || SUDO="sudo"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
SSH=(ssh -o StrictHostKeyChecking=accept-new "$TARGET")

CHAIN_ID=4663
RPC_URL="https://rpc.mainnet.chain.robinhood.com"
EXPLORER_URL="https://robinhoodchain.blockscout.com"
PROBE_JOBS="0x75a7af44fe0117b1f5ff11eddad11fe1e0d34189"
VERIFIER_ADDR="0xd3c30efc0b0867963193c1d2dfd9fe31a442d746"
SITE_ORIGIN="${SITE_ORIGIN:-*}"

say() { printf '\n\033[1;31m▸\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

say "Checking DNS for $DOMAIN"
RESOLVED="$(dig +short "$DOMAIN" A | tail -1 || true)"
if [[ "$RESOLVED" != "$IP" ]]; then
  echo "  $DOMAIN resolves to '${RESOLVED:-nothing}', expected $IP."
  echo "  HTTPS will start working once the A record is in place. Continuing."
fi

say "Connecting to $IP"
"${SSH[@]}" true || die "Cannot SSH to $TARGET. Did you add your SSH key when creating the server?"

say "Installing Docker, swap and the firewall on the server (first run only)"
"${SSH[@]}" $SUDO bash -s <<'REMOTE'
set -e
# Small plans have 1 GB of RAM; swap keeps forge builds from running out of memory.
if [ ! -f /swapfile ] && [ "$(awk '/MemTotal/{print $2}' /proc/meminfo)" -lt 3500000 ]; then
  fallocate -l 3G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh >/dev/null; fi
if command -v ufw >/dev/null; then ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw --force enable >/dev/null; fi
mkdir -p /opt/probe
REMOTE

say "Uploading code"
RSYNC_SUDO=(); [[ -n "$SUDO" ]] && RSYNC_SUDO=(--rsync-path="sudo rsync")
rsync -az --delete \
  --exclude node_modules --exclude .next --exclude .git --exclude '.env*' \
  --exclude 'protocol/.data' --exclude 'protocol/.tmp' --exclude 'contracts/out' --exclude 'contracts/cache' \
  --exclude 'contracts/broadcast' --exclude 'deploy/verifier.env' --exclude 'deploy/.env' \
  ${RSYNC_SUDO[@]+"${RSYNC_SUDO[@]}"} "$ROOT/" "$TARGET:/opt/probe/"

if ! "${SSH[@]}" $SUDO test -f /opt/probe/deploy/verifier.env; then
  say "Unlock the probe-verifier keystore (first run only)"
  echo "  type the password you chose for probe-verifier, then press Enter"
  KEY="$(cast wallet decrypt-keystore probe-verifier | grep -oE '0x[0-9a-fA-F]{64}' | head -1 || true)"
  [[ -n "$KEY" ]] || die "Could not unlock probe-verifier (wrong password?)."
  ADDR="$(cast wallet address --private-key "$KEY" | tr '[:upper:]' '[:lower:]')"
  [[ "$ADDR" == "$VERIFIER_ADDR" ]] || die "Keystore address $ADDR is not the approved verifier $VERIFIER_ADDR."
  # Sent over SSH straight into a root-only file on your server.
  printf '%s\n' \
    "VERIFIER_PRIVATE_KEY=$KEY" \
    "PROBE_JOBS_ADDRESS=$PROBE_JOBS" \
    "RPC_URL=$RPC_URL" \
    "CHAIN_ID=$CHAIN_ID" \
    "NETWORK_NAME=Robinhood Chain" \
    "EXPLORER_URL=$EXPLORER_URL" \
    "CORS_ORIGIN=$SITE_ORIGIN" \
    | "${SSH[@]}" "$SUDO sh -c 'umask 077; cat > /opt/probe/deploy/verifier.env'"
  unset KEY
fi
"${SSH[@]}" "$SUDO sh -c 'umask 077; echo VERIFIER_DOMAIN=$DOMAIN > /opt/probe/deploy/.env'"

say "Building and starting (first build takes a few minutes)"
"${SSH[@]}" "cd /opt/probe/deploy && $SUDO docker compose up -d --build && $SUDO docker image prune -f >/dev/null"

say "Waiting for https://$DOMAIN/health"
for _ in $(seq 1 60); do
  if out="$(curl -fsS "https://$DOMAIN/health" 2>/dev/null)"; then echo "  $out"; break; fi
  sleep 5
done
[[ -n "${out:-}" ]] || die "Not reachable over HTTPS yet. Check DNS and that ports 80/443 are open, then: ssh $TARGET 'cd /opt/probe/deploy && $SUDO docker compose logs --tail 50'"

BAL="$(cast balance "$VERIFIER_ADDR" --rpc-url "$RPC_URL" --ether)"
say "Verifier is live at https://$DOMAIN  (gas balance $BAL ETH)"
echo "  logs:    ssh $TARGET 'cd /opt/probe/deploy && $SUDO docker compose logs -f verifier'"
