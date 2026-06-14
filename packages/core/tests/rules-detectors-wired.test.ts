import { describe, it, expect } from "vitest";
import { loadDefaultRules } from "../src/rules.js";
import { detectPii, type DetectorKey } from "../src/pii-detector.js";

// Guard gegen die Luecke, die KREDITKARTE/API_KEY-Detektoren registriert hat,
// sie aber NICHT in der Rules-Allowlist (detect.pii) freischaltete — wodurch sie
// zur Laufzeit (detectPii(text, { only: rules.detect.pii })) nie liefen.
describe("default rules wire up all regex detectors end-to-end", () => {
  it("aktiviert kreditkarte + api_key in den Default-Rules", () => {
    const rules = loadDefaultRules();
    expect(rules.detect.pii).toContain("kreditkarte");
    expect(rules.detect.pii).toContain("api_key");
  });

  it("erkennt Kreditkarte UND API-Key ueber den Rules-Allowlist-Pfad", () => {
    const rules = loadDefaultRules();
    const found = detectPii(
      "Visa 4111 1111 1111 1111 und Key sk-proj-9aZ3kLmN7pQ2rT8vWx1yB4cD6eF0gH5j",
      { only: rules.detect.pii as DetectorKey[] },
    );
    const types = found.map((f) => f.type);
    expect(types).toContain("KREDITKARTE");
    expect(types).toContain("API_KEY");
  });
});
