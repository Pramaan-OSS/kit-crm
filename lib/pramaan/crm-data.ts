import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient } from "pg";
import { AccountError } from "../accounts";
import { accountRuntime, database } from "../runtime";
import { membership } from "../workspace";
export class CrmProblem extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export const requestUser = new AsyncLocalStorage<string>();
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
export function documentJson(value: unknown) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > MAX_DOCUMENT_BYTES)
    throw new CrmProblem("This workspace is full. Remove entries before saving more.");
  return json;
}
// Internal notes stay one document per workspace; contacts, companies, deals and stages are rows (0106).
type Block = "records";
/**
 * Who is asking, as rechecked under the organisation lock. `only` is the account whose rows they may see and change
 * when the workspace is in one-person mode and they are not its owner; null means every row in the workspace.
 */
export type Access = { user: string; role: "manager" | "editor" | "viewer"; only: string | null };
export function createStore(pool: Pool) {
  function table(block: Block) {
    if (block !== "records") throw new CrmProblem("Choose a workspace list.");
    return `crm_${block}`;
  }
  async function permit(tx: PoolClient, scope: string, write: boolean): Promise<Access> {
    const user = requestUser.getStore();
    if (!user) throw new CrmProblem("Sign in to see this.", 401);
    // The same organisation lock serializes membership changes and every workspace write.
    // Recheck the permission after acquiring it, never trust a prior route check.
    const org = await tx.query(
      "SELECT owner_id,one_person FROM crm_organisations WHERE id=$1 FOR UPDATE",
      [scope],
    );
    const m = await tx.query("SELECT role FROM crm_members WHERE org_id=$1 AND user_id=$2", [
      scope,
      user,
    ]);
    if (!org.rows[0] || !m.rows[0] || (write && m.rows[0].role === "viewer"))
      throw new CrmProblem("You don't have permission to change or open this workspace.", 403);
    const only = org.rows[0].one_person && org.rows[0].owner_id !== user ? user : null;
    return { user, role: m.rows[0].role, only };
  }
  async function transaction<T>(
    scope: string,
    write: boolean,
    work: (tx: PoolClient, access: Access) => Promise<T>,
  ) {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      const value = await work(tx, await permit(tx, scope, write));
      await tx.query("COMMIT");
      return value;
    } catch (e) {
      await tx.query("ROLLBACK");
      // The database's size check measures jsonb's own text, which is longer than JSON.stringify's.
      if ((e as { code?: string }).code === "23514")
        throw new CrmProblem("This workspace is full. Remove entries before saving more.");
      throw e;
    } finally {
      tx.release();
    }
  }
  return {
    /** Runs row queries for one workspace inside its locked, permission-checked transaction. */
    withScope: transaction,
    readData<T>(block: Block, scope: string, initial: T): Promise<T> {
      return transaction(
        scope,
        false,
        async (tx) =>
          (await tx.query(`SELECT data FROM ${table(block)} WHERE scope=$1`, [scope])).rows[0]
            ?.data ?? structuredClone(initial),
      );
    },
    changeData<T>(block: Block, scope: string, initial: T, change: (state: T) => void): Promise<T> {
      return transaction(scope, true, async (tx) => {
        const name = table(block);
        await tx.query(
          `INSERT INTO ${name}(scope,data) VALUES($1,$2::jsonb) ON CONFLICT(scope) DO NOTHING`,
          [scope, documentJson(initial)],
        );
        const rows = await tx.query(`SELECT data FROM ${name} WHERE scope=$1 FOR UPDATE`, [scope]);
        const state = rows.rows[0].data as T;
        change(state);
        const json = documentJson(state);
        await tx.query(`UPDATE ${name} SET data=$2::jsonb WHERE scope=$1`, [scope, json]);
        return JSON.parse(json) as T;
      });
    },
  };
}
export function withScope<T>(
  scope: string,
  write: boolean,
  work: (tx: PoolClient, access: Access) => Promise<T>,
) {
  return createStore(database()).withScope(scope, write, work);
}
export function readData<T>(block: Block, scope: string, initial: T) {
  return createStore(database()).readData(block, scope, initial);
}
export function changeData<T>(block: Block, scope: string, initial: T, change: (state: T) => void) {
  return createStore(database()).changeData(block, scope, initial, change);
}
export function checkRevision(
  record: { revision: number },
  expected: unknown,
  noun: "contact" | "card",
) {
  if (!Number.isSafeInteger(expected) || expected !== record.revision)
    throw new CrmProblem(
      `This ${noun} changed since you opened it. Reload to see the latest.`,
      409,
    );
}
export function text(value: unknown, label: string, max = 200, required = true): string {
  if (typeof value !== "string" || (required && !value.trim()))
    throw new CrmProblem(`Enter ${label}.`);
  if (value.trim().length > max) throw new CrmProblem(`Use ${label} of up to ${max} characters.`);
  return value.trim();
}

const MAX_BODY_BYTES = 20_000;
const shorterEntry = () => new CrmProblem("Please use a shorter entry.");
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  )
    throw new CrmProblem("Please check the form and try again.", 415);
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) throw new CrmProblem("Please check the form and try again.");
    if (Number(declared) > MAX_BODY_BYTES) throw shorterEntry();
  }
  const reader = request.body?.getReader();
  if (!reader) throw new CrmProblem("Please check the form and try again.");
  let size = 0;
  let raw = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw shorterEntry();
      }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new CrmProblem("Please check the form and try again.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new CrmProblem("Please check the form and try again.");
  return body as Record<string, unknown>;
}

export async function crmRoute(
  request: Request,
  run: (scope: string, body: Record<string, unknown>) => Promise<unknown>,
) {
  try {
    const user = await accountRuntime().requireUser(request);
    const member = await membership(database(), user.id);
    if (!member) throw new CrmProblem("Create a workspace or ask its owner to add you.", 403);
    if (
      request.method !== "GET" &&
      request.headers.get("origin") !== (process.env.APP_ORIGIN ?? new URL(request.url).origin)
    )
      throw new CrmProblem("Refresh this page and try again.", 403);
    const body = request.method === "GET" ? {} : await readBody(request);
    return await requestUser.run(user.id, async () =>
      Response.json(await run(member.org_id, body), { headers: { "cache-control": "no-store" } }),
    );
  } catch (e) {
    const status = e instanceof CrmProblem || e instanceof AccountError ? e.status : 503;
    return Response.json(
      {
        error: {
          message:
            e instanceof CrmProblem || e instanceof AccountError
              ? e.message
              : "Workspace storage is unavailable. Please try again.",
        },
      },
      { status, headers: { "cache-control": "no-store" } },
    );
  }
}
