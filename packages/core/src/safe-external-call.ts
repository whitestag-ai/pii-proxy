import type { PiiProxy } from "./index.js";

export interface SafeExternalCallOptions {
  piiProxy: PiiProxy;
  prompt: string;
  targetLlm: string;
  agent: string;
  tenantId?: string;
  externalCall: (anonymizedPrompt: string) => Promise<string>;
}

export type SafeExternalCallResult =
  | { blocked: false; text: string }
  | { blocked: true; reason: string };

export async function safeExternalCall(opts: SafeExternalCallOptions): Promise<SafeExternalCallResult> {
  const a = await opts.piiProxy.anonymize({
    text: opts.prompt,
    targetLlm: opts.targetLlm,
    agent: opts.agent,
    tenantId: opts.tenantId,
  });
  if ("blocked" in a) {
    return { blocked: true, reason: a.reason };
  }
  const externalText = await opts.externalCall(a.anonymizedText);
  const back = opts.piiProxy.deanonymize({ mappingId: a.mappingId, text: externalText });
  return { blocked: false, text: back.text };
}
