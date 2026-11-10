import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { csvCell } from "../admin-table/records";
import { CrmProblem, checkRevision, text, withScope } from "./crm-data";
export type Entry = { text: string; at: string };
export type Contact = {
  id: string;
  revision: number;
  kind: "person" | "company";
  name: string;
  email: string;
  companyId: string;
  notes: Entry[];
  history: Entry[];
};
export type ContactsData = { contacts: Contact[] };
export const MAX_CONTACTS = 2000;
/** Notes and history across a workspace's contacts; each row is also capped at 4 MiB by the database. */
export const MAX_WORKSPACE_NOTE_BYTES = 16 * 1024 * 1024;
// Prepends one history entry and keeps the latest 50.
const withHistory = (entry: string, at: string) =>
  `jsonb_path_query_array(jsonb_build_array(jsonb_build_object('text',${entry}::text,'at',${at}::text)) || history, '$[0 to 49]')`;
const COLUMNS = `r.id,r.revision,r.kind,r.name,r.email,coalesce(c.id::text,'') AS "companyId",r.notes,r.history`;
// $2 is Access.only: in one-person mode a member's rows, and the companies they link to, are only their own.
const FROM = `crm_contact_rows r LEFT JOIN crm_contact_rows c
  ON c.org_id=r.org_id AND c.id=r.company_id AND ($2::uuid IS NULL OR c.owner_id=$2)`;
const VISIBLE = "r.org_id=$1 AND ($2::uuid IS NULL OR r.owner_id=$2)";
async function find(tx: PoolClient, scope: string, only: string | null, id: unknown) {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) return undefined;
  return (
    await tx.query<Contact & { linked: string | null }>(
      `SELECT ${COLUMNS},r.company_id AS linked FROM ${FROM} WHERE ${VISIBLE} AND r.id=$3 FOR UPDATE OF r`,
      [scope, only, id],
    )
  ).rows[0];
}
function list(tx: PoolClient, scope: string, only: string | null, search: string) {
  return tx.query<Contact>(
    `SELECT ${COLUMNS} FROM ${FROM} WHERE ${VISIBLE}
     AND ($3='' OR strpos(lower(r.name||' '||r.email||' '||coalesce(c.name,'')),$3)>0)
     ORDER BY r.seq`,
    [scope, only, search.trim().toLowerCase().slice(0, 200)],
  );
}
export function getContacts(scope: string, search = "") {
  return withScope(scope, false, async (tx, access) => ({
    contacts: (await list(tx, scope, access.only, search)).rows,
  }));
}
/** The contacts this person may see, as CSV. */
export function exportContacts(scope: string) {
  return withScope(scope, false, async (tx, access) => {
    const rows = (await list(tx, scope, access.only, "")).rows;
    const names = new Map(rows.map((c) => [c.id, c.name]));
    return [
      "Name,Type,Email,Company",
      ...rows.map((c) =>
        [c.name, c.kind === "person" ? "Person" : "Company", c.email, names.get(c.companyId) ?? ""]
          .map(csvCell)
          .join(","),
      ),
    ].join("\r\n");
  });
}
export function updateContacts(scope: string, body: Record<string, unknown>) {
  return withScope(scope, true, async (tx, access) => {
    const at = new Date().toISOString();
    const existing = body.id ? await find(tx, scope, access.only, body.id) : undefined;
    if (body.id && !existing) throw new CrmProblem("This contact is no longer available.", 404);
    if (existing) checkRevision(existing, body.revision, "contact");
    const touch = (message: string, set = "", values: unknown[] = []) =>
      tx.query(
        `UPDATE crm_contact_rows SET ${set}history=${withHistory("$3", "$4")},revision=revision+1 WHERE org_id=$1 AND id=$2`,
        [scope, existing?.id, message, at, ...values],
      );
    if (body.action === "delete") {
      if (!existing) throw new CrmProblem("Choose a contact to remove.");
      if (existing.kind === "company")
        await tx.query(
          `UPDATE crm_contact_rows SET history=${withHistory("$3", "$4")},revision=revision+1 WHERE org_id=$1 AND company_id=$2`,
          [scope, existing.id, "Company link removed", at],
        );
      // Cards linked to it lose the link (the key sets it null); a card form opened before this then reloads.
      await tx.query(
        "UPDATE crm_deals SET revision=revision+1 WHERE org_id=$1 AND (company_id=$2 OR contact_id=$2)",
        [scope, existing.id],
      );
      await tx.query("DELETE FROM crm_contact_rows WHERE org_id=$1 AND id=$2", [
        scope,
        existing.id,
      ]);
      return { saved: true };
    }
    if (body.action === "note" || body.action === "delete-note") {
      if (!existing) throw new CrmProblem("Choose a contact for this note.");
      if (body.action === "note") {
        if (existing.notes.length >= 200)
          throw new CrmProblem("This contact has 200 notes. Remove a note to add another.");
        const note = text(body.note, "a note", 4000);
        const used = await tx.query(
          "SELECT coalesce(sum(octet_length(notes::text)+octet_length(history::text)),0) AS bytes FROM crm_contact_rows WHERE org_id=$1",
          [scope],
        );
        if (Number(used.rows[0].bytes) + Buffer.byteLength(note) > MAX_WORKSPACE_NOTE_BYTES)
          throw new CrmProblem("This workspace is full. Remove entries before saving more.");
        await touch(
          "Note added",
          "notes=jsonb_build_array(jsonb_build_object('text',$5::text,'at',$4::text))||notes,",
          [note],
        );
      } else {
        if (
          !Number.isInteger(body.noteIndex) ||
          (body.noteIndex as number) < 0 ||
          (body.noteIndex as number) >= existing.notes.length
        )
          throw new CrmProblem("This note is no longer available.", 404);
        await touch("Note removed", "notes=notes-$5::int,", [body.noteIndex]);
      }
      return { saved: true };
    }
    if (body.action !== "save") throw new CrmProblem("Choose an action to continue.");
    if (body.kind !== "person" && body.kind !== "company")
      throw new CrmProblem("Choose person or company.");
    const name = text(body.name, "a name");
    const email = text(body.email ?? "", "an email address", 254, false);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new CrmProblem("Enter a valid email address.");
    const companyId = text(body.companyId ?? "", "a company", 100, false);
    if (
      companyId &&
      (body.kind !== "person" ||
        (await find(tx, scope, access.only, companyId))?.kind !== "company")
    )
      throw new CrmProblem("Choose a company from this workspace.");
    if (existing && existing.kind !== body.kind)
      throw new CrmProblem("Keep the same contact type.");
    if (existing) {
      // A link to a company this person cannot see is kept, never cleared by a form that could not show it.
      const hidden = !existing.companyId && existing.linked ? existing.linked : "";
      await touch(
        existing.companyId !== companyId ? "Company link changed" : "Contact updated",
        "name=$5,email=$6,company_id=nullif($7,'')::uuid,",
        [name, email, companyId || hidden],
      );
      return { saved: true };
    }
    const count = await tx.query("SELECT count(*) FROM crm_contact_rows WHERE org_id=$1", [scope]);
    if (Number(count.rows[0].count) >= MAX_CONTACTS)
      throw new CrmProblem("This workspace is full. Remove some contacts to add more.");
    await tx.query(
      `INSERT INTO crm_contact_rows(id,org_id,owner_id,kind,name,email,company_id,history)
       VALUES($1,$2,$3,$4,$5,$6,nullif($7,'')::uuid,jsonb_build_array(jsonb_build_object('text','Contact added','at',$8::text)))`,
      [randomUUID(), scope, access.user, body.kind, name, email, companyId, at],
    );
    return { saved: true };
  });
}
