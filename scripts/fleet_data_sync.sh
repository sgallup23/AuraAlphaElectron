#!/usr/bin/env bash
# fleet_data_sync.sh — pull the two trainer state files from EC2 once a day.
#
# WHY: phase2/app/services/ml_trainer_v2.py reads
#   state/ml_features_v2.parquet
#   state/aura_alpha_backtest_results_us.json   <-- the _us.json variant, not no-suffix
# When workers run on a box without an EC2 mount (e.g. a laptop), they need a
# local copy. Shipped 2026-04-27 with v9.4.3 alongside the ml_train fix.
#
# USAGE
#   bash scripts/fleet_data_sync.sh           # one-shot
#   AURA_SYNC_HOST=other-host:port \
#     bash scripts/fleet_data_sync.sh         # override default host
#
#   # cron-friendly daily (3am local):
#   0 3 * * * /usr/bin/flock -xn /tmp/aura_fleet_sync.lock \
#     ~/AuraAlphaElectron/scripts/fleet_data_sync.sh \
#     >> ~/.aura-worker/state-sync.log 2>&1
#
# ENV
#   AURA_SYNC_HOST   - hostname[:port] of source. Default: prodesk-ec2.tail62e000.ts.net
#                      (Tailscale alias; falls through to AURA_SYNC_FALLBACK_HOST on failure)
#   AURA_SYNC_FALLBACK_HOST - secondary host to try if primary unreachable
#                              (default: prodesk-ec2 — assumes ssh_config alias is set)
#   AURA_SYNC_USER   - ssh user. Default: ubuntu
#   AURA_SYNC_DEST   - local destination directory. Default: ~/.aura-worker/state
#   AURA_SYNC_REMOTE_BASE - remote prodesk path. Default: /home/ubuntu/TRADING_DESK/prodesk
#
# IDEMPOTENT
#   Uses rsync --update so re-running mid-day is cheap (no network transfer
#   when the source mtime hasn't advanced). Logs each transfer to stdout.
#
# EXIT CODES
#   0 - success on at least one file
#   1 - both hosts unreachable, no transfer
#   2 - host reachable but rsync errored on every file

set -uo pipefail

PRIMARY_HOST="${AURA_SYNC_HOST:-prodesk-ec2.tail62e000.ts.net}"
FALLBACK_HOST="${AURA_SYNC_FALLBACK_HOST:-prodesk-ec2}"
SSH_USER="${AURA_SYNC_USER:-ubuntu}"
DEST="${AURA_SYNC_DEST:-$HOME/.aura-worker/state}"
REMOTE_BASE="${AURA_SYNC_REMOTE_BASE:-/home/ubuntu/TRADING_DESK/prodesk}"

# Files we need locally. Both keys are sized small (~50 MB total).
FILES=(
  "state/ml_features_v2.parquet"
  "state/aura_alpha_backtest_results_us.json"
)

mkdir -p "${DEST}/state"

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

log() { echo "[$(ts)] $*"; }

# Probe a host with a 5-second TCP connect to port 22.
probe_host() {
  local host="$1"
  local hostonly="${host%%:*}"
  local port="22"
  if [[ "$host" == *:* ]]; then port="${host##*:}"; fi
  # Use bash /dev/tcp; works without nc/netcat installed.
  if timeout 5 bash -c ">/dev/tcp/${hostonly}/${port}" 2>/dev/null; then
    return 0
  fi
  return 1
}

pick_host() {
  if probe_host "${PRIMARY_HOST}"; then
    echo "${PRIMARY_HOST}"
    return 0
  fi
  log "primary host ${PRIMARY_HOST} unreachable; trying fallback ${FALLBACK_HOST}"
  if probe_host "${FALLBACK_HOST}"; then
    echo "${FALLBACK_HOST}"
    return 0
  fi
  return 1
}

main() {
  log "fleet_data_sync.sh starting (dest=${DEST})"

  local host
  if ! host=$(pick_host); then
    log "ERROR: no reachable sync host (primary=${PRIMARY_HOST}, fallback=${FALLBACK_HOST})"
    exit 1
  fi
  log "using host: ${host}"

  local ok=0 fail=0
  for rel in "${FILES[@]}"; do
    local src="${SSH_USER}@${host}:${REMOTE_BASE}/${rel}"
    local dst="${DEST}/${rel}"
    mkdir -p "$(dirname "${dst}")"
    log "rsync ${rel} ..."
    if rsync -az --update --partial --inplace \
        -e "ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new" \
        "${src}" "${dst}" 2>&1; then
      log "  ok: $(stat -c '%s bytes (mtime %y)' "${dst}" 2>/dev/null || echo synced)"
      ok=$((ok + 1))
    else
      log "  rsync failed for ${rel}"
      fail=$((fail + 1))
    fi
  done

  log "done: ${ok} ok, ${fail} failed"
  if [ "${ok}" -eq 0 ]; then
    exit 2
  fi
  exit 0
}

main "$@"
