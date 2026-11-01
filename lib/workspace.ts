import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { AccountError } from "./accounts";
export type Membership = {
  org_id: string;
  name: string;
  role: "manager" | "editor" | "viewer";
  owner_id: string;
};
export async function membership(
  pool: Pick<Pool, "query">,
  user: string,
): Promise<Membership | undefined> {
  return (
    await pool.query<Membership>(
      `SELECT m.org_id,m.role,o.name,o.owner_id FROM crm_members m JOIN crm_organisations o ON o.id=m.org_id WHERE m.user_id=$1`,
      [user],
    )
  ).rows[0];
}
export async function workspaceAction(pool: Pool, user: string, body: Record<string, unknown>) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    if (body.action === "create") {
      // Account lock prevents concurrent workspace creation for one person.
      await tx.query("SELECT id FROM app_users WHERE id=$1 FOR UPDATE", [user]);
      if (await membership(tx, user))
        throw new AccountError(409, "You already belong to a workspace.");
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 120)
        throw new AccountError(400, "Use a workspace name of up to 120 characters.");
      const id = randomUUID();
      await tx.query("INSERT INTO crm_organisations(id,name,owner_id) VALUES($1,$2,$3)", [
        id,
        name,
        user,
      ]);
      await tx.query("INSERT INTO crm_members(org_id,user_id,role) VALUES($1,$2,'manager')", [
        id,
        user,
      ]);
    } else {
      const m = await membership(tx, user);
      if (!m) throw new AccountError(403, "Join a workspace first.");
      await tx.query("SELECT id FROM crm_organisations WHERE id=$1 FOR UPDATE", [m.org_id]);
      const current = await membership(tx, user);
      if (!current || current.org_id !== m.org_id || current.role !== "manager")
        throw new AccountError(403, "Only the workspace owner can change team access.");
      if (body.action === "rename") {
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name || name.length > 120)
          throw new AccountError(400, "Use a workspace name of up to 120 characters.");
        await tx.query("UPDATE crm_organisations SET name=$2 WHERE id=$1", [m.org_id, name]);
      } else if (body.action === "grant") {
        if (body.role !== "editor" && body.role !== "viewer")
          throw new AccountError(400, "Choose Can edit or Read only.");
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        if (!email || email.length > 254) throw new AccountError(400, "Enter their sign-in email.");
        // Lock the account as "create" does, so a grant and their own new workspace never race.
        const account = (
          await tx.query("SELECT id FROM app_users WHERE lower(email)=$1 FOR UPDATE", [email])
        ).rows[0];
        if (!account || account.id === current.owner_id)
          throw new AccountError(
            400,
            "Ask that person to sign up first; the workspace owner keeps their access.",
          );
        const existing = await membership(tx, account.id);
        if (existing && existing.org_id !== m.org_id)
          throw new AccountError(409, "That account cannot be added to this workspace.");
        const count = await tx.query("SELECT count(*) FROM crm_members WHERE org_id=$1", [
          m.org_id,
        ]);
        if (!existing && Number(count.rows[0].count) >= 50)
          throw new AccountError(
            409,
            "This workspace has 50 people. Remove someone before adding another.",
          );
        await tx.query(
          `INSERT INTO crm_members(org_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role WHERE crm_members.org_id=EXCLUDED.org_id`,
          [m.org_id, account.id, body.role],
        );
        const added = await membership(tx, account.id);
        if (added?.org_id !== m.org_id)
          throw new AccountError(409, "That account cannot be added to this workspace.");
      } else if (body.action === "remove") {
        if (typeof body.id !== "string" || !/^[a-f0-9-]{36}$/i.test(body.id))
          throw new AccountError(400, "Choose a team member.");
        if (body.id === current.owner_id)
          throw new AccountError(400, "The workspace owner cannot be removed.");
        await tx.query("DELETE FROM crm_members WHERE org_id=$1 AND user_id=$2", [
          m.org_id,
          body.id,
        ]);
      } else throw new AccountError(400, "Choose a team action.");
    }
    await tx.query("COMMIT");
    return { saved: true };
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}
