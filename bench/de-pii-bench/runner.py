#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PII-Proxy DE-Benchmark-Runner.
Schickt jeden Testfall an POST <base>/anonymize (Header X-PII-Proxy-Key=$PII_BENCH_KEY),
misst Latenz, und bewertet Recall pro Kategorie + Art.9-Block-Quote + Falsch-Positive.

Usage: PII_BENCH_KEY=... python3 runner.py <baseUrl> <modelLabel> > result.json
"""
import json, os, sys, time, urllib.request, urllib.error
from cases import CASES

BASE = sys.argv[1].rstrip("/")
MODEL = sys.argv[2] if len(sys.argv) > 2 else "unknown"
KEY = os.environ["PII_BENCH_KEY"]


def call_anonymize(text):
    body = json.dumps({"text": text, "targetLlm": "bench", "agent": "de-pii-bench"}).encode()
    req = urllib.request.Request(
        BASE + "/anonymize", data=body, method="POST",
        headers={"content-type": "application/json", "X-PII-Proxy-Key": KEY},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=240) as r:
            dt = time.time() - t0
            return json.loads(r.read().decode()), dt, None
    except urllib.error.HTTPError as e:
        dt = time.time() - t0
        try:
            return json.loads(e.read().decode()), dt, f"HTTP {e.code}"
        except Exception:
            return {}, dt, f"HTTP {e.code}"
    except Exception as e:
        return {}, time.time() - t0, str(e)


per_case = []
for c in CASES:
    resp, dt, err = call_anonymize(c["text"])
    blocked = bool(resp.get("blocked"))
    anon = resp.get("anonymizedText", "")
    # Detection: pii-Substring gilt als erkannt, wenn er im anonymizedText NICHT mehr woertlich steht
    # (bei block gilt alles als "geschuetzt", weil nichts rausgeht).
    detected = []
    for p in c.get("pii", []):
        if blocked:
            detected.append({"pii": p, "ok": True, "via": "blocked"})
        else:
            ok = p not in anon
            detected.append({"pii": p, "ok": ok, "via": "anonymized" if ok else "MISSED"})
    per_case.append({
        "id": c["id"], "cat": c["cat"], "art9": c.get("art9", False), "fp": c.get("fp", False),
        "blocked": blocked, "reason": resp.get("reason") or resp.get("blockedReason"),
        "latency_s": round(dt, 2), "error": err, "detected": detected,
        "changed": (not blocked) and (anon != "") and (anon != c["text"]),
        "n_pii": len(c.get("pii", [])), "n_ok": sum(1 for d in detected if d["ok"]),
    })

# Aggregation
from collections import defaultdict
cat = defaultdict(lambda: {"det": 0, "tot": 0})
for pc in per_case:
    if pc["art9"] or pc["fp"]:
        continue
    cat[pc["cat"]]["det"] += pc["n_ok"]
    cat[pc["cat"]]["tot"] += pc["n_pii"]

art9_cases = [pc for pc in per_case if pc["art9"]]
art9_blocked = sum(1 for pc in art9_cases if pc["blocked"])
neg_cases = [pc for pc in per_case if pc["fp"]]
neg_block_fp = sum(1 for pc in neg_cases if pc["blocked"])
neg_replace_fp = sum(1 for pc in neg_cases if pc["changed"])

lats = sorted(pc["latency_s"] for pc in per_case)
def pct(p):
    if not lats: return None
    return lats[min(len(lats) - 1, int(p * len(lats)))]

out = {
    "model": MODEL,
    "n_cases": len(per_case),
    "per_category_recall": {k: {"detected": v["det"], "total": v["tot"],
                                "recall": round(v["det"] / v["tot"], 3) if v["tot"] else None}
                            for k, v in sorted(cat.items())},
    "art9_block": {"blocked": art9_blocked, "total": len(art9_cases),
                   "rate": round(art9_blocked / len(art9_cases), 3) if art9_cases else None},
    "negatives": {"false_block": neg_block_fp, "false_replace": neg_replace_fp, "total": len(neg_cases)},
    "latency_s": {"p50": pct(0.5), "p90": pct(0.9), "max": lats[-1] if lats else None,
                  "mean": round(sum(lats) / len(lats), 2) if lats else None},
    "missed": [{"id": pc["id"], "cat": pc["cat"],
                "missed": [d["pii"] for d in pc["detected"] if not d["ok"]]}
               for pc in per_case if not pc["art9"] and not pc["fp"] and pc["n_ok"] < pc["n_pii"]],
    "art9_leaks": [{"id": pc["id"], "reason": pc["reason"]} for pc in art9_cases if not pc["blocked"]],
    "errors": [{"id": pc["id"], "error": pc["error"]} for pc in per_case if pc["error"]],
    "per_case": per_case,
}
print(json.dumps(out, ensure_ascii=False, indent=2))
