import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const Schema = z.object({
  PII_PROXY_PORT: z.coerce.number().default(4711),
  PII_PROXY_BIND: z.string().default("0.0.0.0"),
  PII_PROXY_SHARED_KEY: z.string().min(32, "PII_PROXY_SHARED_KEY must be at least 32 chars"),
  PII_PROXY_MAPPING_DB: z.string().default(join(homedir(), ".pii-proxy", "mappings.db")),
  PII_PROXY_AUDIT_DIR: z.string().default(join(homedir(), ".pii-proxy", "audit")),
  PII_PROXY_CLASSIFIER_URL: z.string().default("http://localhost:1234"),
  PII_PROXY_CLASSIFIER_MODEL: z.string().default("gemma-4-26b"),
  PII_PROXY_CLASSIFIER_TIMEOUT_MS: z.coerce.number().default(30000),
  PII_PROXY_TELEGRAM_BOT_TOKEN: z.string().optional(),
  PII_PROXY_TELEGRAM_CHAT_ID: z.string().optional(),
});

export interface ServiceConfig {
  port: number;
  bind: string;
  sharedKey: string;
  mappingDbPath: string;
  auditDir: string;
  classifier: { url: string; model: string; timeoutMs: number };
  telegram?: { botToken: string; chatId: string };
}

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): ServiceConfig {
  const parsed = Schema.parse(env);
  const telegram = parsed.PII_PROXY_TELEGRAM_BOT_TOKEN && parsed.PII_PROXY_TELEGRAM_CHAT_ID
    ? { botToken: parsed.PII_PROXY_TELEGRAM_BOT_TOKEN, chatId: parsed.PII_PROXY_TELEGRAM_CHAT_ID }
    : undefined;
  return {
    port: parsed.PII_PROXY_PORT,
    bind: parsed.PII_PROXY_BIND,
    sharedKey: parsed.PII_PROXY_SHARED_KEY,
    mappingDbPath: parsed.PII_PROXY_MAPPING_DB,
    auditDir: parsed.PII_PROXY_AUDIT_DIR,
    classifier: {
      url: parsed.PII_PROXY_CLASSIFIER_URL,
      model: parsed.PII_PROXY_CLASSIFIER_MODEL,
      timeoutMs: parsed.PII_PROXY_CLASSIFIER_TIMEOUT_MS,
    },
    telegram,
  };
}
