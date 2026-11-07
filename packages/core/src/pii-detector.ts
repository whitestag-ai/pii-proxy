import type { Finding } from "./types.js";
import { detectEmails } from "./detectors/email.js";
import { detectPhonesDe, detectPhonesDeStrict } from "./detectors/phone-de.js";
import { detectIbans } from "./detectors/iban.js";
import { detectBics } from "./detectors/bic.js";
import { detectUstIds } from "./detectors/ust-id.js";
import { detectSteuernummern } from "./detectors/steuernummer.js";
import { detectPlzDe } from "./detectors/plz-de.js";
import { detectUrls } from "./detectors/url.js";
import { detectCreditCards } from "./detectors/creditcard.js";
import { detectApiKeys } from "./detectors/apikey.js";
import { detectSecrets } from "./detectors/secret.js";

export type DetectorKey =
  | "email"
  | "phone_de"
  | "iban"
  | "bic"
  | "ust_id"
  | "steuernummer"
  | "plz_de"
  | "url"
  | "kreditkarte"
  | "api_key"
  | "phone_de_strict"
  | "secret";

const DETECTORS: Record<DetectorKey, (t: string) => Finding[]> = {
  email: detectEmails,
  phone_de: detectPhonesDe,
  iban: detectIbans,
  bic: detectBics,
  ust_id: detectUstIds,
  steuernummer: detectSteuernummern,
  plz_de: detectPlzDe,
  url: detectUrls,
  kreditkarte: detectCreditCards,
  api_key: detectApiKeys,
  phone_de_strict: detectPhonesDeStrict,
  secret: detectSecrets,
};

/**
 * Muster fuer Text, der nicht durch den Classifier laeuft (Werkzeug-Ausgaben).
 * Nur Formen mit wenigen Fehltreffern: Das Modell muss diesen Text lesen koennen,
 * und PLZ-, URL- oder Kreditkarten-Muster treffen dort vor allem IDs und Zahlen.
 */
export const REGEX_ONLY_DETECTORS: DetectorKey[] = [
  "email",
  "phone_de_strict",
  "iban",
  "api_key",
  "secret",
];

export interface PiiDetectOptions {
  only?: DetectorKey[];
}

export function detectPii(text: string, opts: PiiDetectOptions = {}): Finding[] {
  const keys =
    opts.only ??
    (Object.keys(DETECTORS) as DetectorKey[]).filter((k) => k !== "phone_de_strict");
  const all: Finding[] = [];
  for (const k of keys) {
    all.push(...DETECTORS[k](text));
  }
  return resolveOverlaps(all);
}

function resolveOverlaps(findings: Finding[]): Finding[] {
  const sorted = [...findings].sort(
    (a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start),
  );
  const out: Finding[] = [];
  let lastEnd = -1;
  for (const f of sorted) {
    if (f.start >= lastEnd) {
      out.push(f);
      lastEnd = f.end;
    }
  }
  return out;
}
