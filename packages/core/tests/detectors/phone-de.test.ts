import { describe, it, expect } from "vitest";
import { detectPhonesDe, detectPhonesDeStrict } from "../../src/detectors/phone-de.js";

describe("detectPhonesDe", () => {
  it("findet +49-Format", () => {
    const f = detectPhonesDe("Tel: +49 30 12345678");
    expect(f).toHaveLength(1);
    expect(f[0].type).toBe("PHONE");
  });

  it("findet 0049-Format", () => {
    expect(detectPhonesDe("Ruf 0049 30 12345678 an")).toHaveLength(1);
  });

  it("findet 030-Format", () => {
    expect(detectPhonesDe("030 12345678")).toHaveLength(1);
  });

  it("findet 030-1234-5678 mit Bindestrichen", () => {
    expect(detectPhonesDe("030-1234-5678")).toHaveLength(1);
  });

  it("ignoriert reine Zahlen ohne Telefon-Form", () => {
    expect(detectPhonesDe("Bestellnummer 12345")).toEqual([]);
  });
});

describe("detectPhonesDeStrict", () => {
  const werte = (t: string) => detectPhonesDeStrict(t).map((f) => f.value);

  it("findet Nummern mit klaren Grenzen", () => {
    expect(werte("Tel. +49 171 1234567.")).toEqual(["+49 171 1234567"]);
    expect(werte("Fon: 030/1234567")).toEqual(["030/1234567"]);
    expect(werte("(0171-1234567)")).toEqual(["0171-1234567"]);
  });

  it("trifft nichts mitten in IDs, UUIDs, Datumspfaden und Dezimalzahlen", () => {
    for (const t of [
      "3fa85f64-0717-4562-b3fc-2c963f66afa6",
      "a01234567b",
      "commit 9012345678",
      "/runs/2026/0110/1234567-0",
      "12.0123456",
      "2026-01-07 09:15:02",
      "v0123456-beta",
    ]) {
      expect(werte(t), t).toEqual([]);
    }
  });
});
