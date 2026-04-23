import Fastify, { type FastifyInstance } from "fastify";
import type { PiiProxy } from "@whitestag/pii-proxy-core";
import { registerAuth } from "./auth.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerAnonymizeRoute } from "./routes/anonymize.js";
import { registerDeanonymizeRoute } from "./routes/deanonymize.js";
import { registerSafeCallRoute } from "./routes/safe-call.js";

export interface BuildServerOptions {
  sharedKey: string;
  classifierUrl: string;
  dpo: PiiProxy;
  fetchFn?: typeof fetch;
  logger?: boolean;
}

export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  registerAuth(app, { sharedKey: opts.sharedKey });
  registerHealthRoute(app, { classifierUrl: opts.classifierUrl, fetchFn: opts.fetchFn });
  registerAnonymizeRoute(app, { dpo: opts.dpo });
  registerDeanonymizeRoute(app, { dpo: opts.dpo });
  registerSafeCallRoute(app, { dpo: opts.dpo, fetchFn: opts.fetchFn });
  await app.ready();
  return app;
}
