#!/usr/bin/env bash
# add_backup_hostname.sh — wire a newly-registered backup hostname to the
# existing auraalpha.cc Cloudflare zone via the Cloudflare API.
#
# Prereqs (one-time, manual):
#   1. Register the hostname (e.g. auraalpha.app) at any registrar.
#      Cloudflare Registrar is at-cost — easiest path.
#   2. Add the new hostname as a zone in the same Cloudflare account that
#      already hosts auraalpha.cc. Update its NS records at the registrar
#      to Cloudflare's nameservers (Cloudflare shows them in the dashboard).
#   3. Create a Cloudflare API Token with permissions:
#        Zone -> Zone -> Read   (all zones in account)
#        Zone -> DNS  -> Edit   (the new hostname's zone)
#      Save it to ~/.cloudflare-api-token (chmod 600).
#
# Usage:
#   ./add_backup_hostname.sh auraalpha.app
#
# What it does:
#   - Looks up the new hostname's zone ID via Cloudflare API.
#   - Adds two proxied A records (apex + www) pointing at the same EC2 IP
#     as auraalpha.cc (currently 54.172.235.137). Cloudflare proxy hides
#     the origin IP and reuses the existing edge cert via Universal SSL.
#   - Idempotent: if records already exist, leaves them alone.
#
# Why A records, not CNAME-to-auraalpha.cc:
#   CNAME flattening at apex works on Cloudflare, but a direct A record is
#   simpler, doesn't double-resolve, and matches how auraalpha.cc itself
#   is configured. Both apex and www proxied so the cert covers either.

set -euo pipefail

NEW_HOSTNAME="${1:-}"
ORIGIN_IP="${ORIGIN_IP:-54.172.235.137}"
TOKEN_FILE="${CF_TOKEN_FILE:-$HOME/.cloudflare-api-token}"

if [[ -z "$NEW_HOSTNAME" ]]; then
  echo "Usage: $0 <hostname>   (e.g. auraalpha.app)" >&2
  exit 2
fi

if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  TOKEN="$CLOUDFLARE_API_TOKEN"
elif [[ -f "$TOKEN_FILE" ]]; then
  TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
else
  echo "ERROR: No Cloudflare API token. Set CLOUDFLARE_API_TOKEN or write one to $TOKEN_FILE" >&2
  exit 3
fi

API="https://api.cloudflare.com/client/v4"
hdr=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

echo "→ Looking up zone for $NEW_HOSTNAME..."
ZONE_JSON="$(curl -fsS "${hdr[@]}" "$API/zones?name=$NEW_HOSTNAME")"
ZONE_ID="$(echo "$ZONE_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["result"][0]["id"] if d.get("result") else "")')"

if [[ -z "$ZONE_ID" ]]; then
  echo "ERROR: $NEW_HOSTNAME is not a zone in this Cloudflare account."
  echo "Add it via Cloudflare dashboard first, point its registrar NS to Cloudflare, then re-run."
  exit 4
fi
echo "  zone_id=$ZONE_ID"

upsert_a_record() {
  local name="$1"
  local existing
  existing="$(curl -fsS "${hdr[@]}" "$API/zones/$ZONE_ID/dns_records?type=A&name=$name" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); r=d.get("result") or []; print(r[0]["id"] if r else "")')"

  local body
  body="$(python3 -c "import json; print(json.dumps({'type':'A','name':'$name','content':'$ORIGIN_IP','ttl':1,'proxied':True}))")"

  if [[ -n "$existing" ]]; then
    echo "→ A $name already exists (id=$existing) — updating to $ORIGIN_IP, proxied=true"
    curl -fsS -X PUT "${hdr[@]}" "$API/zones/$ZONE_ID/dns_records/$existing" --data "$body" >/dev/null
  else
    echo "→ Creating A $name → $ORIGIN_IP (proxied)"
    curl -fsS -X POST "${hdr[@]}" "$API/zones/$ZONE_ID/dns_records" --data "$body" >/dev/null
  fi
}

upsert_a_record "$NEW_HOSTNAME"
upsert_a_record "www.$NEW_HOSTNAME"

echo
echo "✓ DNS wired. Cloudflare Universal SSL will issue an edge cert within ~60s."
echo "  Verify:    dig +short $NEW_HOSTNAME"
echo "  Probe:     curl -sI https://$NEW_HOSTNAME/api/health"
echo
echo "Once 'curl https://$NEW_HOSTNAME/api/health' returns 200, the v9.5.0 build"
echo "(already on branch network-backup-hostnames) can be tagged and pushed:"
echo "    cd ~/AuraAlphaElectron && git push -u origin network-backup-hostnames \\"
echo "      && git tag v9.5.0 && git push --tags"
