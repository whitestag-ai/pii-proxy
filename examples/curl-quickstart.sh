#!/usr/bin/env bash
set -euo pipefail

URL="${1:-http://localhost:4711}"
KEY="${PII_PROXY_SHARED_KEY:?set PII_PROXY_SHARED_KEY}"

echo "→ health"
curl -s "$URL/health" | tee /dev/stderr; echo

echo "→ anonymize"
RESP=$(curl -s -f \
  -H "x-pii-proxy-key: $KEY" \
  -H "content-type: application/json" \
  -d '{"text":"Max Mustermann (max@whitestag.de)","targetLlm":"gpt-4o","agent":"demo"}' \
  "$URL/anonymize")
echo "$RESP"

MID=$(echo "$RESP" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("mappingId",""))')
[[ -z "$MID" ]] && { echo "blocked"; exit 1; }

ATEXT=$(echo "$RESP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["anonymizedText"])')

echo "→ deanonymize"
curl -s -f \
  -H "x-pii-proxy-key: $KEY" \
  -H "content-type: application/json" \
  -d "{\"mappingId\":\"$MID\",\"text\":\"hello $ATEXT!\"}" \
  "$URL/deanonymize"
echo

echo "OK"
