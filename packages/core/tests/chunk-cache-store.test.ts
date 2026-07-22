import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Finding } from "../src/types.js";
import { EncryptedChunkCacheStore } from "../src/chunk-cache-store.js";

function person(value: string, confidence: Finding["confidence"] = "high"): Finding {
  return { type: "PERSON", value, start: 0, end: value.length, confidence, source: "llm" };
}

describe("EncryptedChunkCacheStore", () => {
  let dir: string;
  let dbPath: string;
  let key: Buffer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pii-chunkcache-"));
    dbPath = join(dir, "chunk-cache.db");
    key = randomBytes(32);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persistiert Findings über eine neue Instanz hinweg (überlebt Neustart)", () => {
    const s1 = new EncryptedChunkCacheStore({ path: dbPath, key, ttlSeconds: 86400 });
    s1.set("hash-a", [person("Dr. Anna Müller")]);
    s1.close();

    // Neue Instanz, gleiche Datei + Key = Simulation eines Proxy-Neustarts.
    const s2 = new EncryptedChunkCacheStore({ path: dbPath, key, ttlSeconds: 86400 });
    const got = s2.get("hash-a");
    s2.close();
    expect(got).toBeDefined();
    expect(got).toHaveLength(1);
    expect(got![0].value).toBe("Dr. Anna Müller");
    expect(got![0].type).toBe("PERSON");
  });

  it("liefert undefined für unbekannten Hash", () => {
    const s = new EncryptedChunkCacheStore({ path: dbPath, key, ttlSeconds: 86400 });
    expect(s.get("gibtsnicht")).toBeUndefined();
    s.close();
  });

  it("round-trippt einen leeren Findings-Array (Chunk ohne PII bleibt gecacht)", () => {
    const s = new EncryptedChunkCacheStore({ path: dbPath, key, ttlSeconds: 86400 });
    s.set("leer", []);
    expect(s.get("leer")).toEqual([]);
    s.close();
  });

  it("verfällt Einträge nach TTL (injizierbare Uhr)", () => {
    let now = 1_000_000_000;
    const s = new EncryptedChunkCacheStore({
      path: dbPath,
      key,
      ttlSeconds: 10,
      clock: () => now,
    });
    s.set("h", [person("Anna")]);
    now += 5000; // 5s < TTL
    expect(s.get("h")).toBeDefined();
    now += 6000; // insgesamt 11s > TTL
    expect(s.get("h")).toBeUndefined();
    s.close();
  });

  it("speichert PII-Werte NICHT im Klartext auf der Platte (verschlüsselt at rest)", () => {
    const s = new EncryptedChunkCacheStore({ path: dbPath, key, ttlSeconds: 86400 });
    s.set("h", [person("Dr. Anna Müller")]);
    s.close();
    const raw = readFileSync(dbPath);
    expect(raw.includes(Buffer.from("Anna Müller", "utf8"))).toBe(false);
  });

  it("fail-closed bei falschem Key: get liefert undefined statt Müll (kein Throw)", () => {
    const s1 = new EncryptedChunkCacheStore({ path: dbPath, key, ttlSeconds: 86400 });
    s1.set("h", [person("Dr. Anna Müller")]);
    s1.close();

    const wrongKey = randomBytes(32);
    const s2 = new EncryptedChunkCacheStore({ path: dbPath, key: wrongKey, ttlSeconds: 86400 });
    expect(s2.get("h")).toBeUndefined();
    s2.close();
  });
});
