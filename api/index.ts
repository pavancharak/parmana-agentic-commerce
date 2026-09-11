import { requestHandler } from "../src/server/handler.js";

/**
 * Vercel Node.js Function entrypoint. Reuses the exact same request
 * handler the local http.Server (src/server/index.ts) uses -- no
 * behavior fork between local dev and this deployment. Never calls
 * .listen(): Vercel invokes this handler per-request itself.
 * vercel.json rewrites every path to this one function.
 */
export default requestHandler;
