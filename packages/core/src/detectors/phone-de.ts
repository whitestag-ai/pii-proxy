import type { Finding } from "../types.js";

const PHONE_RE = /(?:\+49|0049|0)[\s\-]?(?:\d{2,5})[\s\-/]?\d{3,}(?:[\s\-]?\d{2,})*/g;

export function detectPhonesDe(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const m of text.matchAll(PHONE_RE)) {
    const value = m[0].trim();
    const digitCount = (value.match(/\d/g) ?? []).length;
    if (digitCount < 7) continue;
    findings.push({
      type: "PHONE",
      value,
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      confidence: "high",
      source: "regex",
    });
  }
  return findings;
}

// Strenge Fassung fuer Werkzeug-Ausgaben: Dort stehen IDs, UUIDs und Datumspfade,
// in denen das obige Muster ohne Wortgrenzen fast nur Fehltreffer liefert.
const PHONE_STRICT_RE =
  /(?<![\w./:+-])(?:\+49|0049|0)[ \-/]?\d{2,5}[ \-/]?\d{3,}(?:[ \-]?\d{2,})*(?![\w/:-]|\.\d)/g;

export function detectPhonesDeStrict(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const m of text.matchAll(PHONE_STRICT_RE)) {
    const digitCount = (m[0].match(/\d/g) ?? []).length;
    if (digitCount < 8 || digitCount > 15) continue;
    findings.push({
      type: "PHONE",
      value: m[0],
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      confidence: "high",
      source: "regex",
    });
  }
  return findings;
}
