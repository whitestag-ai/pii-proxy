import type { Finding } from "../types.js";

// Candidate: 13–19 digits grouped by single spaces or hyphens.
// We over-match here on purpose (recall first) and then filter with Luhn,
// which is the actual false-positive guard against random digit runs,
// order numbers and IBAN digit-sequences.
const CARD_RE = /\b\d(?:[ -]?\d){12,18}\b/g;

/** Luhn checksum on the digits-only form. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function detectCreditCards(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const m of text.matchAll(CARD_RE)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    if (!luhnValid(digits)) continue;
    findings.push({
      type: "KREDITKARTE",
      value: m[0],
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      confidence: "high",
      source: "regex",
    });
  }
  return findings;
}
