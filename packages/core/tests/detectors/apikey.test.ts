import { describe, it, expect } from "vitest";
import { detectApiKeys } from "../../src/detectors/apikey.js";

describe("detectApiKeys", () => {
  it("findet OpenAI sk-proj Key", () => {
    const f = detectApiKeys("key=sk-proj-9aZ3kLmN7pQ2rT8vWx1yB4cD6eF0gH5j");
    expect(f).toHaveLength(1);
    expect(f[0].type).toBe("API_KEY");
    expect(f[0].confidence).toBe("high");
    expect(f[0].source).toBe("regex");
    expect(f[0].value).toBe("sk-proj-9aZ3kLmN7pQ2rT8vWx1yB4cD6eF0gH5j");
  });

  it("findet GitHub ghp Token", () => {
    const f = detectApiKeys("ghp_AbCdEf1234567890GhIjKlMnOpQrStUvWx");
    expect(f).toHaveLength(1);
    expect(f[0].value).toBe("ghp_AbCdEf1234567890GhIjKlMnOpQrStUvWx");
  });

  it("findet AWS Access Key Id", () => {
    const f = detectApiKeys("AKIAIOSFODNN7EXAMPLE");
    expect(f).toHaveLength(1);
    expect(f[0].value).toBe("AKIAIOSFODNN7EXAMPLE");
  });

  it("findet Google API Key", () => {
    const f = detectApiKeys("AIzaSyA1234567890abcdefghijklmnopqrstuv");
    expect(f).toHaveLength(1);
    expect(f[0].value).toBe("AIzaSyA1234567890abcdefghijklmnopqrstuv");
  });

  it("findet Slack Token", () => {
    const f = detectApiKeys("xoxb-EXAMPLE-NOT-A-REAL-SLACK-TOKEN");
    expect(f).toHaveLength(1);
    expect(f[0].value).toBe("xoxb-EXAMPLE-NOT-A-REAL-SLACK-TOKEN");
  });

  it("findet Stripe Live Secret Key", () => {
    const f = detectApiKeys("sk_live_1234567890abcdefABCDEF");
    expect(f).toHaveLength(1);
    expect(f[0].value).toBe("sk_live_1234567890abcdefABCDEF");
  });

  it("ignoriert blanken sk- Präfix ohne Body", () => {
    expect(detectApiKeys("sk-")).toEqual([]);
  });

  it("ignoriert zu kurzen ghp_ Token", () => {
    expect(detectApiKeys("ghp_short")).toEqual([]);
  });

  it("ignoriert einen normalen Satz ohne Secrets", () => {
    expect(
      detectApiKeys("Dies ist ein ganz normaler Satz ohne Geheimnisse."),
    ).toEqual([]);
  });

  it("liefert korrekte start/end-Offsets", () => {
    const text = "Mein Token ist ghp_AbCdEf1234567890GhIjKlMnOpQrStUvWx ok";
    const f = detectApiKeys(text);
    expect(f).toHaveLength(1);
    expect(text.slice(f[0].start, f[0].end)).toBe(f[0].value);
  });
});
