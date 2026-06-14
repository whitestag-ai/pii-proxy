import type { Finding } from "../types.js";

// High-signal secret formats. Each alternative is prefix-anchored and carries
// a minimum body length so that ordinary words / short tokens do not match.
// Recall is prioritised, precision is bought via the mandatory prefix + length.
const API_KEY_RE = new RegExp(
  [
    // OpenAI: sk- / sk-proj- + >=20 body chars
    "sk-(?:proj-)?[A-Za-z0-9_-]{20,}",
    // GitHub PATs and tokens: ghp_/gho_/ghs_/ghu_/ghr_/github_pat_ + >=20
    "(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9_]{20,}",
    "github_pat_[A-Za-z0-9_]{20,}",
    // AWS access key id: AKIA/ASIA + 16 uppercase alnum
    "(?:AKIA|ASIA)[A-Z0-9]{16}",
    // Google API key: AIza + 35 chars
    "AIza[A-Za-z0-9_-]{35}",
    // Slack: xoxb-/xoxa-/xoxp-/xoxr-/xoxs- + >=10 body chars
    "xox[baprs]-[A-Za-z0-9-]{10,}",
    // Stripe live keys: sk_live_/rk_live_/pk_live_ + >=16
    "(?:sk|rk|pk)_live_[A-Za-z0-9]{16,}",
  ].join("|"),
  "g",
);

export function detectApiKeys(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const m of text.matchAll(API_KEY_RE)) {
    findings.push({
      type: "API_KEY",
      value: m[0],
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      confidence: "high",
      source: "regex",
    });
  }
  return findings;
}
