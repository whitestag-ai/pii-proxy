import type { Finding } from "../types.js";

// Name einer Zuweisung, deren Wert geheim ist. Fundstelle ist immer nur der Wert,
// damit der Text lesbar bleibt ("PASS=[API_KEY_A]").
const ASSIGNMENT_RE =
  /(?<![A-Za-z0-9_])([A-Za-z0-9_.-]*(?:key|token|secret|passwd|password|pwd|pass|jwt|credential)s?)["']?[ \t]*[:=][ \t]*(?:"([^"\n]{8,})"|'([^'\n]{8,})'|((?!\$)[^\s"'`,;&|(){}[\]<>\\]{8,}))/gi;

// Env-Zeilen mit Namen in Grossbuchstaben: Der Wert darf Sonderzeichen enthalten
// und reicht bis zum Wortende. Das obige Muster wuerde ihn abschneiden.
const ENV_LINE_RE =
  /(?<![A-Za-z0-9_])[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWD|PASSWORD|PWD|PASS|JWT|CREDENTIAL)S?=(?!\$)([^\s"'`]{8,})/g;

// Teile von Woertern, die zufaellig auf ein Schluesselwort enden.
const HARMLESS_NAME_RE =
  /bypass|compass|keyword|monkey|hockey|turkey|donkey|max_?tokens|public_?key|name_?key|url_?key|idempotency_?key/i;

const NOT_A_VALUE_RE =
  /^(?:\d+|true|false|null|undefined|none|string|number|boolean|required|optional)$|^(?:process\.env|os\.environ|env\.|\[)/i;

// Tokens, die an ihrer Form erkennbar sind.
const SHAPED_TOKEN_RE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\bpcp_(?:board_|cli_auth_)?[0-9a-f]{40,}/g;

// Pfade sind keine Geheimnisse.
const PATH_RE = /^(?:\/|~\/|\.\/)/;

const BEARER_RE = /\bBearer[ \t]+([A-Za-z0-9._~+/-]{16,}=*)/g;

function finding(text: string, start: number, end: number): Finding {
  return {
    type: "API_KEY",
    value: text.slice(start, end),
    start,
    end,
    confidence: "high",
    source: "regex",
  };
}

export function detectSecrets(text: string): Finding[] {
  const findings: Finding[] = [];
  // Ein Wert kann mehreren Mustern entsprechen. Das erste gewinnt, deshalb stehen
  // die Muster mit dem laengsten Treffer vorn.
  const add = (start: number, end: number): void => {
    if (findings.some((f) => start < f.end && f.start < end)) return;
    findings.push(finding(text, start, end));
  };

  for (const m of text.matchAll(SHAPED_TOKEN_RE)) {
    const start = m.index ?? 0;
    add(start, start + m[0].length);
  }

  for (const m of text.matchAll(ENV_LINE_RE)) {
    const name = m[0].slice(0, m[0].length - m[1].length - 1);
    if (HARMLESS_NAME_RE.test(name) || NOT_A_VALUE_RE.test(m[1]) || PATH_RE.test(m[1])) continue;
    const end = (m.index ?? 0) + m[0].length;
    add(end - m[1].length, end);
  }

  for (const m of text.matchAll(ASSIGNMENT_RE)) {
    const name = m[1];
    const quoted = m[2] ?? m[3];
    const value = quoted ?? m[4];
    if (HARMLESS_NAME_RE.test(name) || NOT_A_VALUE_RE.test(value)) continue;
    // Ein blosses "key" ist meist ein Feldname, ohne Ziffer im Wert kein Schluessel.
    if (name.toLowerCase() === "key" && !/\d/.test(value)) continue;
    if (quoted === undefined) {
      // Unquotierte Bezeichner sind in Code Verweise ("apiKey: config.apiKey").
      if (/^[A-Za-z_][A-Za-z_.]*$/.test(value) && !/^[A-Z0-9_]+$/.test(name)) continue;
      if (PATH_RE.test(value)) continue;
    }
    const end = (m.index ?? 0) + m[0].length - (quoted === undefined ? 0 : 1);
    add(end - value.length, end);
  }

  for (const m of text.matchAll(BEARER_RE)) {
    const end = (m.index ?? 0) + m[0].length;
    add(end - m[1].length, end);
  }

  return findings;
}
