#!/usr/bin/env bash
# check_reputation.sh — public reputation probe for auraalpha.cc
#
# Hits the lookup endpoints we can reach without auth and writes a one-line
# JSON summary. Use to know when the Tailscale fallback (and the BACKUP_URLS
# probe overhead) can be retired.
#
# Cron-friendly. Idempotent. Exit code 0 even on partial failures so cron
# doesn't email noise.
#
# Usage:
#   ./check_reputation.sh              # probes auraalpha.cc, prints + appends to state
#   DOMAIN=auraalpha.app ./check_reputation.sh

set -uo pipefail

DOMAIN="${DOMAIN:-auraalpha.cc}"
STATE_DIR="$(cd "$(dirname "$0")/.." && pwd)/state"
STATE_FILE="$STATE_DIR/reputation_status.json"
mkdir -p "$STATE_DIR"

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 1. Google Safe Browsing transparency report (HTML scrape — no public API for site lookup)
gsb_status="unknown"
if html="$(curl -sS -m 10 "https://transparencyreport.google.com/safe-browsing/search?url=$DOMAIN" 2>/dev/null)"; then
  if echo "$html" | grep -qi "no unsafe content"; then
    gsb_status="clean"
  elif echo "$html" | grep -qi "unsafe"; then
    gsb_status="flagged"
  else
    gsb_status="reachable_no_signal"
  fi
else
  gsb_status="unreachable"
fi

# 2. Cloudflare Radar (HEAD only — page exists if domain is in their dataset)
cf_status="unknown"
if curl -sS -m 10 -o /dev/null -w "%{http_code}" "https://radar.cloudflare.com/domains/feedback/$DOMAIN" 2>/dev/null | grep -q "^200"; then
  cf_status="reachable"
else
  cf_status="unreachable"
fi

# 3. Cisco Talos reputation lookup (returns JSON when the host is in their cache)
talos_status="unknown"
if curl -sS -m 10 -A "Mozilla/5.0" -o /dev/null -w "%{http_code}" "https://talosintelligence.com/sb_api/query_lookup?query=%2Fapi%2Fv2%2Fdetails%2Fdomain%2F&query_entry=$DOMAIN" 2>/dev/null | grep -q "^200"; then
  talos_status="reachable"
else
  talos_status="unreachable"
fi

# 4. xFi-style live probe — does auraalpha.cc resolve to our IP and serve health from this network?
own_status="unknown"
if curl -fsS -m 10 "https://$DOMAIN/api/health" >/dev/null 2>&1; then
  own_status="ok"
else
  own_status="blocked_or_down"
fi

# Single line of JSON for grep-ability + history append
line="$(python3 -c "
import json
print(json.dumps({
  'ts': '$ts',
  'domain': '$DOMAIN',
  'google_safe_browsing': '$gsb_status',
  'cloudflare_radar': '$cf_status',
  'cisco_talos': '$talos_status',
  'origin_reachable_from_here': '$own_status',
}))
")"

echo "$line" | tee -a "$STATE_FILE"
exit 0
