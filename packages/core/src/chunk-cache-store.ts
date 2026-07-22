import Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Database as DB } from "better-sqlite3";
import type { Finding } from "./types.js";

/**
 * Persistenter, VERSCHLÜSSELTER Backing-Store für den Chunk-Findings-Cache.
 *
 * Warum verschlüsselt: Findings enthalten die erkannten PII-WERTE selbst
 * (z. B. Personennamen). Sie im Klartext auf Platte zu schreiben würde den
 * Zweck des PII-Proxy untergraben. Daher AES-256-GCM at rest — identisches
 * Muster wie die bestehende `mappings.db` (gleicher 32-Byte-Schlüssel).
 *
 * Warum persistent: Der riesige statische System-/Skills-Prefix eines Agenten-
 * Prompts ist über ALLE Agenten und ALLE Heartbeats identisch. Der reine
 * In-Memory-Cache verliert ihn bei jedem Proxy-Neustart, sodass jeder erste
 * Heartbeat dutzende Chunks neu klassifizieren muss (Minuten). Persistiert
 * wird der Prefix genau einmal je eindeutigem Chunk klassifiziert und danach
 * über Neustarts hinweg wiederverwendet.
 *
 * Fail-closed: Entschlüsselung mit falschem/rotiertem Schlüssel schlägt fehl
 * (GCM-Auth) — `get` liefert dann `undefined` (Cache-Miss → Neuklassifikation),
 * niemals halbgare/falsche Findings.
 */
export interface EncryptedChunkCacheStoreOptions {
  path: string;
  /** 32-Byte-Schlüssel (AES-256). */
  key: Buffer;
  /** Lebensdauer eines Eintrags in Sekunden. */
  ttlSeconds: number;
  /** Injizierbare Uhr (ms) für Tests. Default: Date.now. */
  clock?: () => number;
}

interface Row {
  findings_enc: Buffer;
  findings_iv: Buffer;
  findings_tag: Buffer;
  created_at: number;
  ttl_seconds: number;
}

export class EncryptedChunkCacheStore {
  private readonly db: DB;
  private readonly key: Buffer;
  private readonly ttlSeconds: number;
  private readonly clock: () => number;

  constructor(opts: EncryptedChunkCacheStoreOptions) {
    if (opts.key.length !== 32) {
      throw new Error("Chunk cache store key must be 32 bytes");
    }
    this.db = new Database(opts.path);
    this.key = opts.key;
    this.ttlSeconds = opts.ttlSeconds;
    this.clock = opts.clock ?? Date.now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunk_findings (
        hash          TEXT PRIMARY KEY,
        findings_enc  BLOB NOT NULL,
        findings_iv   BLOB NOT NULL,
        findings_tag  BLOB NOT NULL,
        created_at    INTEGER NOT NULL,
        ttl_seconds   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunk_findings_cleanup
        ON chunk_findings(created_at, ttl_seconds);
    `);
  }

  get(hash: string): Finding[] | undefined {
    const row = this.db
      .prepare<[string], Row>(`SELECT * FROM chunk_findings WHERE hash = ?`)
      .get(hash);
    if (!row) return undefined;
    // TTL abgelaufen -> als Miss behandeln (und aufräumen).
    if ((row.created_at + row.ttl_seconds) * 1000 <= this.clock()) {
      this.db.prepare(`DELETE FROM chunk_findings WHERE hash = ?`).run(hash);
      return undefined;
    }
    try {
      const json = this.decrypt(row.findings_enc, row.findings_iv, row.findings_tag);
      const parsed = JSON.parse(json) as Finding[];
      if (!Array.isArray(parsed)) return undefined;
      return parsed;
    } catch {
      // Auth-/Parse-Fehler (z. B. rotierter Schlüssel) -> fail-closed als Miss.
      return undefined;
    }
  }

  set(hash: string, findings: Finding[]): void {
    const { ciphertext, iv, tag } = this.encrypt(JSON.stringify(findings));
    const now = Math.floor(this.clock() / 1000);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO chunk_findings
           (hash, findings_enc, findings_iv, findings_tag, created_at, ttl_seconds)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(hash, ciphertext, iv, tag, now, this.ttlSeconds);
  }

  cleanup(): number {
    const now = Math.floor(this.clock() / 1000);
    return this.db
      .prepare(`DELETE FROM chunk_findings WHERE (created_at + ttl_seconds) <= ?`)
      .run(now).changes;
  }

  close(): void {
    this.db.close();
  }

  private encrypt(plaintext: string): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { ciphertext, iv, tag };
  }

  private decrypt(ciphertext: Buffer, iv: Buffer, tag: Buffer): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}
