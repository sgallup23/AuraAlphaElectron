#!/usr/bin/env bash
# cleanup_orphan_autostarts.sh
#
# Enforces the "Electron app owns the worker lifecycle" rule on a worker
# machine. Stops and disables every systemd-user service / cron entry
# that respawns bots, grid workers, or OHLCV cachers without the Electron
# app being open. Auxiliary services (frontend, api, state-sync, backups,
# disk/resource guards) are left alone.
#
# Idempotent — safe to re-run. Run as your normal user, NOT root.
#
# Usage:
#   bash ~/AuraAlphaElectron/scripts/cleanup_orphan_autostarts.sh           # show what would change
#   bash ~/AuraAlphaElectron/scripts/cleanup_orphan_autostarts.sh --apply   # actually do it

set -uo pipefail

DRY_RUN=1
if [[ "${1:-}" == "--apply" ]]; then
  DRY_RUN=0
fi

BANNER="[orphan-cleanup]"
log()  { echo "$BANNER $*"; }
do_cmd() {
  if [[ $DRY_RUN -eq 1 ]]; then
    log "DRY: $*"
  else
    log "RUN: $*"
    eval "$@" || true
  fi
}

# ── User systemd units that respawn bots / grid workers / cachers ────
ORPHAN_USER_UNITS=(
  aura-grid-worker.service
  aura-local-worker.service
  aura-bot-shawn.service
  aura-bot-shane.service
  aura-equity-shawn.service
  aura-equity-shane.service
  aura-crypto.service
  aura-daemon.service
  aura-ohlcv-daemon.service
  aura-ohlcv-nightly.service
  aura-ohlcv-nightly.timer
  aura-blitz-daily.service
  aura-blitz-daily.timer
  aura-operator-brain.service
  aura-operator-api.service
  aura-operator-ui.service
)

# ── Cron lines that respawn workers (matched substrings) ──────────────
ORPHAN_CRON_PATTERNS=(
  "start_research_workers.sh"
  "start_grid.sh"
  "start_layla.sh"
  "start_local_worker.sh"
  "research_cron.sh"
  "daily_pull.sh"
  "run_holly_webpull.sh"
  "cache_ibkr_ohlcv_v3.py.*--mode cron"
  "competitive_monitor.py"
  "gpt_task_queue.py"
  "supervisor.sh"
  "failover_watchdog.sh"
)

log "Mode: $([[ $DRY_RUN -eq 1 ]] && echo DRY-RUN || echo APPLY)"

# ── 1. Kill anything currently running ──
log "--- killing in-flight workers ---"
do_cmd "pkill -TERM -f 'distributed_research.standalone'"
do_cmd "pkill -TERM -f 'bots\\.paper\\.'"
do_cmd "pkill -TERM -f 'bots\\.equity\\.engine'"
do_cmd "pkill -TERM -f 'cache_ibkr_ohlcv_v3.py'"
do_cmd "pkill -TERM -f 'multiprocessing.spawn'"
sleep 2
do_cmd "pkill -KILL -f 'distributed_research.standalone'"
do_cmd "pkill -KILL -f 'bots\\.paper\\.'"
do_cmd "pkill -KILL -f 'bots\\.equity\\.engine'"
do_cmd "pkill -KILL -f 'cache_ibkr_ohlcv_v3.py'"
do_cmd "pkill -KILL -f 'multiprocessing.spawn'"

# ── 2. Stop+disable user systemd units ──
log "--- disabling systemd-user units ---"
USER_UNIT_DIR="$HOME/.config/systemd/user"
for u in "${ORPHAN_USER_UNITS[@]}"; do
  if [[ ! -f "$USER_UNIT_DIR/$u" ]]; then
    continue
  fi
  log "found unit: $u"
  do_cmd "XDG_RUNTIME_DIR=/run/user/\$(id -u) systemctl --user stop $u 2>/dev/null"
  do_cmd "XDG_RUNTIME_DIR=/run/user/\$(id -u) systemctl --user disable $u 2>/dev/null"
  # Also remove leftover symlinks (if --user disable failed without bus)
  for tgt in default.target.wants multi-user.target.wants timers.target.wants; do
    link="$USER_UNIT_DIR/$tgt/$u"
    [[ -L "$link" ]] && do_cmd "rm -f '$link'"
  done
done

# ── 3. Comment out worker-spawning cron entries ──
log "--- editing crontab ---"
TMP=$(mktemp)
trap "rm -f $TMP" EXIT

if crontab -l > "$TMP" 2>/dev/null; then
  PATTERN_ALT=$(printf '|%s' "${ORPHAN_CRON_PATTERNS[@]}")
  PATTERN_ALT=${PATTERN_ALT:1}
  CHANGED=0
  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*# ]]; then
      printf '%s\n' "$line"
    elif [[ "$line" =~ $PATTERN_ALT ]]; then
      printf '# DISABLED (orphan-cleanup %s): %s\n' "$(date -u +%Y-%m-%dT%H:%MZ)" "$line"
      CHANGED=$((CHANGED+1))
    else
      printf '%s\n' "$line"
    fi
  done < "$TMP" > "$TMP.new"

  if [[ $CHANGED -gt 0 ]]; then
    log "would disable $CHANGED cron entries"
    if [[ $DRY_RUN -eq 0 ]]; then
      crontab "$TMP.new"
      log "crontab updated"
    fi
  else
    log "no cron lines matched"
  fi
fi

# ── 4. Final verify ──
log "--- final state ---"
PROCS=$(pgrep -af 'distributed_research|bots\.paper|bots\.equity|cache_ibkr_ohlcv_v3|multiprocessing.spawn' | grep -v cleanup_orphan | wc -l)
log "remaining bot/worker procs: $PROCS"

log "Done. Re-run with --apply if this was a dry run."
