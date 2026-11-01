import { listRecords, saveRecord } from "../../../../lib/admin-table/records";
import { crmRoute } from "../../../../lib/pramaan/crm-data";

type Context = { params: Promise<{ entity: string }> };
export async function GET(request: Request, context: Context) {
  if ((await context.params).entity !== "note")
    return Response.json({ error: "Choose notes." }, { status: 404 });
  return crmRoute(request, async (scope) => {
    const data = await listRecords(scope);
    const search = new URL(request.url).searchParams.get("search")?.toLowerCase() ?? "";
    const records = data.records.filter((r) =>
      `${r.title} ${r.notes}`.toLowerCase().includes(search),
    );
    return { records, total: records.length };
  });
}
export async function POST(request: Request, context: Context) {
  if ((await context.params).entity !== "note")
    return Response.json({ error: "Choose notes." }, { status: 404 });
  return crmRoute(request, saveRecord);
}
