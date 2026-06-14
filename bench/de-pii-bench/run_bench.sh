#!/bin/bash
# DE-PII-Benchmark-Orchestrator.
# Pro Modell: startet eine Wegwerf-pii-proxy-Instanz auf :4712 (eigene DB/Audit/Key, Classifier=<model>),
# Warmup, dann runner.py, killt die Instanz. Live-:4711 bleibt unberuehrt.
# Usage: ./run_bench.sh "<model-id-1>" "<model-id-2>" ...
set -u
BENCHDIR="$(cd "$(dirname "$0")" && pwd)"
SERVERDIR="$HOME/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/opensource/pii-proxy/packages/server"
PORT=4712
OUTDIR="$BENCHDIR/results"
mkdir -p "$OUTDIR" /tmp/pii-bench/audit
export PII_BENCH_KEY="benchKeyOnlyForLocalEval_$(date +%s)_padding_32chars_min"
export PATH="$HOME/.lmstudio/bin:$PATH"

run_one() {
  local MODEL="$1"
  local SAFE; SAFE=$(echo "$MODEL" | tr '/@ .' '____')
  echo "================ MODEL: $MODEL ================"
  rm -f /tmp/pii-bench/mappings.db
  # Wegwerf-Server starten
  ( cd "$SERVERDIR" && \
    PII_PROXY_PORT=$PORT PII_PROXY_BIND=127.0.0.1 \
    PII_PROXY_SHARED_KEY="$PII_BENCH_KEY" \
    PII_PROXY_MAPPING_KEY_BASE64="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')" \
    PII_PROXY_MAPPING_DB=/tmp/pii-bench/mappings.db \
    PII_PROXY_AUDIT_DIR=/tmp/pii-bench/audit \
    PII_PROXY_CLASSIFIER_URL=http://localhost:1234 \
    PII_PROXY_CLASSIFIER_MODEL="$MODEL" \
    PII_PROXY_CLASSIFIER_TIMEOUT_MS=240000 \
    node dist/index.js ) > "/tmp/pii-bench/server-$SAFE.log" 2>&1 &
  local SRV=$!
  # Health abwarten
  local up=0
  for i in $(seq 1 30); do
    sleep 1
    if curl -s --max-time 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q 200; then up=1; break; fi
  done
  if [ "$up" != 1 ]; then echo "  SERVER NICHT HOCHGEKOMMEN — log:"; tail -8 "/tmp/pii-bench/server-$SAFE.log"; kill $SRV 2>/dev/null; return 1; fi
  echo "  server up (pid $SRV). Warmup (laedt Modell in LM Studio)..."
  curl -s --max-time 240 -X POST "http://127.0.0.1:$PORT/anonymize" \
    -H "content-type: application/json" -H "X-PII-Proxy-Key: $PII_BENCH_KEY" \
    -d '{"text":"Warmup mit Anna Müller.","targetLlm":"bench","agent":"warmup"}' -o /dev/null
  echo "  messe..."
  python3 "$BENCHDIR/runner.py" "http://127.0.0.1:$PORT" "$MODEL" > "$OUTDIR/result-$SAFE.json" 2>"/tmp/pii-bench/runner-$SAFE.err"
  local rc=$?
  if [ "$rc" != 0 ]; then echo "  RUNNER-FEHLER:"; cat "/tmp/pii-bench/runner-$SAFE.err"; fi
  kill $SRV 2>/dev/null; sleep 1
  echo "  -> $OUTDIR/result-$SAFE.json"
}

for M in "$@"; do run_one "$M"; done
echo "=== fertig. Ergebnisse in $OUTDIR ==="
ls -1 "$OUTDIR"
