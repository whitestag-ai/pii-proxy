import type { FastifyReply } from "fastify";

/**
 * Liefert ein AbortSignal, das abbricht, sobald der Client die Verbindung
 * schließt, BEVOR die Antwort vollständig gesendet ist. Ohne dieses Signal
 * liefe die (teure, chunked) Klassifikation im Proxy weiter, nachdem der
 * Claude-CLI nach seinem Timeout aufgegeben und den nächsten Retry gestartet
 * hat — die Läufe stapeln sich dann zu parallelen verwaisten Klassifikationen
 * auf derselben GPU (so kippte der Proxy am 2026-07-24 mit 119 verwaisten
 * Requests).
 *
 * WICHTIG: Es wird auf die RESPONSE (`reply.raw`) gehört und der `writableEnded`
 * geprüft. Das `close`-Event feuert nämlich AUCH beim regulären Ende der
 * Antwort — ein bloßes `req.raw.on("close")` (auf dem Request-Stream) würde
 * zusätzlich beim normalen Ende des gelesenen Request-Bodys feuern, also VOR
 * der Klassifikation, und jede fertige Anfrage fälschlich als Abbruch werten
 * (→ `classifier_unavailable`). `writableEnded === false` heißt: die Antwort
 * war noch nicht raus, die Verbindung starb vorzeitig → echter Client-Abbruch.
 */
export function abortSignalOnClientClose(reply: FastifyReply): AbortSignal {
  const ctrl = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableEnded) ctrl.abort();
  });
  return ctrl.signal;
}
