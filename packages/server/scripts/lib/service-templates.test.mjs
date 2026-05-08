import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLaunchdPlist, renderSystemdUnit } from "./service-templates.mjs";

const ctx = {
  serviceName: "io.piiproxy.server",
  displayName: "PII Proxy",
  description: "GDPR-compliant anonymisation gate",
  nodeBin: "/usr/local/bin/node",
  entryPoint: "/opt/pii-proxy/dist/index.js",
  workingDir: "/opt/pii-proxy",
  env: { PII_PROXY_SHARED_KEY: "test-key" },
  stdoutLog: "/var/log/pii-proxy/out.log",
  stderrLog: "/var/log/pii-proxy/err.log",
};

test("renderLaunchdPlist for pii-proxy", () => {
  const plist = renderLaunchdPlist(ctx);
  assert.match(plist, /<string>io\.piiproxy\.server<\/string>/);
  assert.match(plist, /PII_PROXY_SHARED_KEY/);
});

test("renderSystemdUnit for pii-proxy", () => {
  const unit = renderSystemdUnit(ctx);
  assert.match(unit, /Description=GDPR-compliant anonymisation gate/);
  assert.match(unit, /Environment="PII_PROXY_SHARED_KEY=test-key"/);
});
