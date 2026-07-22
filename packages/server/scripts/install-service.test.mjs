import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const script = path.join(here, "install-service.mjs");

function runDry(platform, extraEnv = {}) {
  return spawnSync(process.execPath, [script, "--dry-run", `--platform=${platform}`], {
    cwd: path.dirname(here),
    env: {
      ...process.env,
      PII_PROXY_SHARED_KEY: "test-key-32chars-padding-padding-padding",
      PII_PROXY_MAPPING_KEY_BASE64: Buffer.alloc(32).toString("base64"),
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

test("dry-run darwin emits plist", () => {
  const r = runDry("darwin");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /<string>io\.piiproxy\.server<\/string>/);
});

test("dry-run linux emits systemd unit", () => {
  const r = runDry("linux");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[Service\]/);
  assert.match(r.stdout, /Environment="PII_PROXY_SHARED_KEY=/);
});

test("dry-run win32 emits service config", () => {
  const r = runDry("win32");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"name":\s*"io\.piiproxy\.server"/);
});

test("reicht optionale Classifier-Fallback- und Chunk-Cache-ENV in die Plist durch", () => {
  const r = runDry("darwin", {
    PII_PROXY_CLASSIFIER_FALLBACK_MODEL: "google/gemma-4-12b",
    PII_PROXY_CLASSIFIER_RETRIES: "2",
    PII_PROXY_CLASSIFIER_RETRY_BACKOFF_MS: "1500",
    PII_PROXY_CHUNK_CACHE_DB: "/tmp/chunk-cache.db",
    PII_PROXY_CHUNK_CACHE_TTL_SECONDS: "604800",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PII_PROXY_CLASSIFIER_FALLBACK_MODEL[\s\S]*google\/gemma-4-12b/);
  assert.match(r.stdout, /PII_PROXY_CLASSIFIER_RETRIES/);
  assert.match(r.stdout, /PII_PROXY_CLASSIFIER_RETRY_BACKOFF_MS/);
  assert.match(r.stdout, /PII_PROXY_CHUNK_CACHE_DB/);
  assert.match(r.stdout, /PII_PROXY_CHUNK_CACHE_TTL_SECONDS/);
});
