import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("reads env vars with defaults", () => {
    const cfg = loadConfig({
      PII_PROXY_SHARED_KEY: "secret-key-32-bytes-min-length-padding-more",
    });
    expect(cfg.port).toBe(4711);
    expect(cfg.bind).toBe("0.0.0.0");
    expect(cfg.sharedKey).toBe("secret-key-32-bytes-min-length-padding-more");
    expect(cfg.classifier.url).toBe("http://localhost:1234");
    expect(cfg.classifier.model).toBe("gemma-4-26b");
    expect(cfg.classifier.timeoutMs).toBe(30000);
    expect(cfg.telegram).toBeUndefined();
    expect(cfg.mappingDbPath).toMatch(/\.pii-proxy\/mappings\.db$/);
    expect(cfg.auditDir).toMatch(/\.pii-proxy\/audit$/);
  });

  it("includes telegram when both env vars set", () => {
    const cfg = loadConfig({
      PII_PROXY_SHARED_KEY: "secret-key-32-bytes-min-length-padding-more",
      PII_PROXY_TELEGRAM_BOT_TOKEN: "bot-token",
      PII_PROXY_TELEGRAM_CHAT_ID: "12345",
    });
    expect(cfg.telegram).toEqual({ botToken: "bot-token", chatId: "12345" });
  });

  it("rejects short shared key", () => {
    expect(() => loadConfig({
      PII_PROXY_SHARED_KEY: "short",
    })).toThrow(/PII_PROXY_SHARED_KEY/);
  });

  it("rejects missing shared key", () => {
    expect(() => loadConfig({})).toThrow();
  });
});
