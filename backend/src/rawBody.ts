import type { FastifyInstance } from "fastify";

/**
 * Keeps the raw request body alongside the parsed one.
 *
 * Every HMAC in this system is computed over the exact bytes the sender
 * transmitted. Re-serialising a parsed object will not reproduce them — key
 * order, whitespace and number formatting all differ — so a signature checked
 * against `JSON.stringify(req.body)` fails for legitimate callers and, worse,
 * tempts you to "fix" it by loosening the check.
 */
export interface RawBody<T = unknown> {
  raw: string;
  parsed: T;
}

export function registerRawJsonParser(app: FastifyInstance) {
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const raw = typeof body === "string" ? body : "";
    try {
      // An empty body is legitimate — the cranks take no payload — and must not
      // blow up in the parser before the route is even reached.
      done(null, { raw, parsed: raw ? JSON.parse(raw) : {} } satisfies RawBody);
    } catch {
      done(new SyntaxError("Body is not valid JSON"), undefined);
    }
  });
}
