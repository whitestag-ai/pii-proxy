#!/usr/bin/env node
import { info, ok, fail } from "./lib/console.mjs";

const url = process.argv[2] ?? "http://localhost:4711";
const key = process.env.PII_PROXY_SHARED_KEY;
if (!key) { fail("PII_PROXY_SHARED_KEY env var required"); process.exit(1); }

async function jsonFetch(path, init) {
  const r = await fetch(url + path, init);
  if (!r.ok) throw new Error(`${path} → ${r.status} ${r.statusText}: ${await r.text()}`);
  return r.json();
}

try {
  info("GET /health");
  const health = await jsonFetch("/health");
  ok(JSON.stringify(health));

  info("POST /anonymize");
  const anon = await jsonFetch("/anonymize", {
    method: "POST",
    headers: { "x-pii-proxy-key": key, "content-type": "application/json" },
    body: JSON.stringify({ text: "Hi Max Mustermann (max@example.com)", targetLlm: "gpt-4o-mini", agent: "smoke" }),
  });
  if (!anon.mappingId) throw new Error("anonymize did not return mappingId (blocked?)");
  ok(`mappingId=${anon.mappingId}`);

  info("POST /deanonymize");
  const deanon = await jsonFetch("/deanonymize", {
    method: "POST",
    headers: { "x-pii-proxy-key": key, "content-type": "application/json" },
    body: JSON.stringify({ mappingId: anon.mappingId, text: `Reply to ${anon.anonymizedText}` }),
  });
  ok(JSON.stringify(deanon));
  ok("smoke OK");
} catch (e) {
  fail(e.message);
  process.exit(1);
}
