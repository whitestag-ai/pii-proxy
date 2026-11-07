import { describe, it, expect } from "vitest";
import { detectSecrets } from "../../src/detectors/secret.js";

const werte = (t: string) => detectSecrets(t).map((f) => t.slice(f.start, f.end));

describe("detectSecrets", () => {
  it("findet Env-Zuweisungen und nimmt nur den Wert", () => {
    expect(werte("WHITESTAG_FILM_SFTP_PASS=aB3$xY9!kL\nOTHER=1")).toEqual(["aB3$xY9!kL"]);
    expect(werte("export N8N_API_KEY='abc def 123456'")).toEqual(["abc def 123456"]);
    expect(werte('BETTER_AUTH_SECRET="0123456789abcdef"')).toEqual(["0123456789abcdef"]);
    expect(werte("MAILPASS=nurbuchstaben")).toEqual(["nurbuchstaben"]);
    expect(werte("FTP_PASS=a9;&b(c)$d e")).toEqual(["a9;&b(c)$d"]);
  });

  it("findet JSON- und YAML-Felder", () => {
    expect(werte('{"password": "geheim-123", "name": "x"}')).toEqual(["geheim-123"]);
    expect(werte("apiKey: a1b2c3d4e5")).toEqual(["a1b2c3d4e5"]);
  });

  it("findet Bearer, JWT, Paperclip-Keys und private Schluessel", () => {
    expect(werte("Authorization: Bearer abcdefghij0123456789")).toEqual(["abcdefghij0123456789"]);
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijkl";
    expect(werte(`x ${jwt} y`)).toEqual([jwt]);
    const pcp = `pcp_board_${"a1".repeat(24)}`;
    expect(werte(`Key ${pcp}.`)).toEqual([pcp]);
    const pem = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    expect(werte(pem)).toEqual([pem]);
  });

  it("ignoriert Code, Verweise, Zahlen und harmlose Namen", () => {
    for (const t of [
      "const token = randomBytes(24)",
      "apiKey: config.apiKey",
      "password: string",
      "PAPERCLIP_API_KEY=$PAPERCLIP_API_KEY",
      "api_key=${API_KEY}",
      "token: process.env.TOKEN",
      "max_tokens: 12345678",
      "bypass=abcdefgh1",
      'executionAgentNameKey: "vp-engineering"',
      '"key": "issue-triage"',
      "keyword: abcdefgh1",
      "GSC_SA_KEY_FILE=/pfad/zur/datei.json",
      "SECRET=[API_KEY_A]",
    ]) {
      expect(werte(t), t).toEqual([]);
    }
  });
});
