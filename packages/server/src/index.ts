#!/usr/bin/env node
import { createPiiProxy } from "@whitestag/pii-proxy-core";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { AuditTailer } from "./audit-tail.js";
import { Monitor } from "./monitor.js";
import { startMonitorRunner } from "./monitor-runner.js";
import { makeClassifierProbe } from "./classifier-probe.js";
import { postTelegram } from "./telegram.js";

async function resolveMappingKey(): Promise<Buffer> {
  const fromEnv = process.env.PII_PROXY_MAPPING_KEY_BASE64;
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, "base64");
    if (buf.length !== 32) {
      throw new Error("PII_PROXY_MAPPING_KEY_BASE64 must decode to exactly 32 bytes");
    }
    return buf;
  }
  // Fall back to OS keychain (macOS). Linux without libsecret → this will throw.
  const { getOrCreateMappingKey } = await import("@whitestag/pii-proxy-core/keychain");
  return getOrCreateMappingKey();
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const mappingKey = await resolveMappingKey();

  const dpo = createPiiProxy({
    mappingDbPath: cfg.mappingDbPath,
    mappingKey,
    auditDir: cfg.auditDir,
    classifier: cfg.classifier,
  });

  const app = await buildServer({
    sharedKey: cfg.sharedKey,
    classifierUrl: cfg.classifier.url,
    dpo,
    logger: true,
  });

  const alertFn = cfg.telegram
    ? (msg: string) => void postTelegram({
        botToken: cfg.telegram!.botToken,
        chatId: cfg.telegram!.chatId,
        text: msg,
      })
    : (msg: string) => console.error("[ALERT]", msg);

  const monitor = new Monitor({ alertFn });
  const tailer = new AuditTailer({ dir: cfg.auditDir });
  const probe = makeClassifierProbe({ url: cfg.classifier.url, timeoutMs: 3000 });
  const stopRunner = startMonitorRunner({ tailer, classifierProbe: probe, monitor });

  const shutdown = async (): Promise<void> => {
    stopRunner();
    await app.close();
    dpo.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await app.listen({ port: cfg.port, host: cfg.bind });
  console.log(`pii-proxy-server listening on ${cfg.bind}:${cfg.port}`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
