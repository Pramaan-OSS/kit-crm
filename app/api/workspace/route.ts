import { handle, readBody, reply } from "../../../lib/roles/http";
import { accountRuntime, database } from "../../../lib/runtime";
import { membership, workspaceAction } from "../../../lib/workspace";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return handle(async () => {
    const user = await accountRuntime().requireUser(request);
    const m = await membership(database(), user.id);
    if (!m) return reply({ workspace: null, members: [] });
    const members = await database().query(
      `SELECT m.user_id AS id,u.email,m.role FROM crm_members m JOIN app_users u ON u.id=m.user_id WHERE m.org_id=$1 ORDER BY m.role,u.email`,
      [m.org_id],
    );
    return reply({ workspace: { name: m.name, role: m.role }, members: members.rows });
  });
}
export async function POST(request: Request) {
  return handle(async () => {
    const user = await accountRuntime().requireUser(request);
    return reply(await workspaceAction(database(), user.id, await readBody(request)));
  });
}
