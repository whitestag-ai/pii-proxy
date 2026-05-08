import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const script = path.join(here, "install-service.mjs");

function runDry(platform) {
  return spawnSync(process.execPath, [script, "--dry-run", `--platform=${platform}`], {
    cwd: path.dirname(here),
    env: {
      ...process.env,
      PII_PROXY_SHARED_KEY: "test-key-32chars-padding-padding-padding",
      PII_PROXY_MAPPING_KEY_BASE64: Buffer.alloc(32).toString("base64"),
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
