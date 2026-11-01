// What the blocks' route handlers share: a JSON body read as lib/accounts.ts reads one (same origin, JSON only,
// bounded), answers that are never cached, and errors turned into words a person can act on.
import { AccountError } from "../accounts";

const MAX_BODY_BYTES = 16_384;

export function reply(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

/** A JSON object from a same-origin POST, or an AccountError a person can act on. */
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  const origin = process.env.APP_ORIGIN ?? new URL(request.url).origin;
  if (request.headers.get("origin") !== origin)
    throw new AccountError(403, "Refresh this page and try again.");
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new AccountError(415, "Send JSON.");
  const reader = request.body?.getReader();
  if (!reader) throw new AccountError(400, "A request body is required.");
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new AccountError(413, "This request is too large.");
      }
      parts.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (value !== null && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* answered below */
  }
  throw new AccountError(400, "Check the submitted information.");
}

/** Runs a route's work and answers its result, or the error as `{ error }` with its status. */
export async function handle(work: () => Promise<Response>) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AccountError) return reply({ error: error.message }, error.status);
    console.error("request failed", error instanceof Error ? error.message : error);
    return reply({ error: "Something went wrong. Please try again." }, 503);
  }
}
