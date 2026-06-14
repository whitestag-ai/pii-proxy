import { describe, it, expect } from "vitest";
import { detectCreditCards } from "../../src/detectors/creditcard.js";

describe("detectCreditCards", () => {
  it("findet Visa-Testnummer mit Leerzeichen", () => {
    const f = detectCreditCards("Karte: 4111 1111 1111 1111");
    expect(f).toHaveLength(1);
    expect(f[0].type).toBe("KREDITKARTE");
    expect(f[0].confidence).toBe("high");
    expect(f[0].source).toBe("regex");
    expect(f[0].value).toBe("4111 1111 1111 1111");
  });

  it("findet Visa-Testnummer ohne Trenner", () => {
    const f = detectCreditCards("4111111111111111");
    expect(f).toHaveLength(1);
    expect(f[0].value).toBe("4111111111111111");
  });

  it("findet Mastercard-Testnummer mit Leerzeichen", () => {
    const f = detectCreditCards("5555 5555 5555 4444");
    expect(f).toHaveLength(1);
    expect(f[0].value).toBe("5555 5555 5555 4444");
  });

  it("findet Karte mit Bindestrichen", () => {
    const f = detectCreditCards("5555-5555-5555-4444");
    expect(f).toHaveLength(1);
    expect(f[0].value).toBe("5555-5555-5555-4444");
  });

  it("ignoriert Luhn-ungültige 16-stellige Zahl", () => {
    expect(detectCreditCards("1234 5678 9012 3456")).toEqual([]);
  });

  it("ignoriert eine Telefonnummer", () => {
    expect(detectCreditCards("Tel +49 30 12345678")).toEqual([]);
  });

  it("ignoriert eine IBAN (beginnt mit Buchstaben / Luhn schlägt fehl)", () => {
    expect(detectCreditCards("DE89 3704 0044 0532 0130 00")).toEqual([]);
  });

  it("liefert korrekte start/end-Offsets", () => {
    const text = "Zahlung mit 4111111111111111 erledigt";
    const f = detectCreditCards(text);
    expect(f).toHaveLength(1);
    expect(text.slice(f[0].start, f[0].end)).toBe(f[0].value);
    expect(f[0].value).toBe("4111111111111111");
  });
});
