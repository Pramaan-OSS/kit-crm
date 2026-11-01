import { csvCell, listRecords } from "../../../../../lib/admin-table/records";
import { crmRoute } from "../../../../../lib/pramaan/crm-data";
export async function GET(request: Request, context: { params: Promise<{ entity: string }> }) {
  if ((await context.params).entity !== "note")
    return new Response("Choose notes.", { status: 404 });
  const result = await crmRoute(request, listRecords);
  if (!result.ok) return result;
  const { records } = await result.json();
  return new Response(
    [
      "Title,Notes",
      ...records.map((r: { title: string; notes: string }) =>
        [r.title, r.notes].map(csvCell).join(","),
      ),
    ].join("\r\n"),
    {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": "attachment; filename=notes.csv",
        "cache-control": "no-store",
      },
    },
  );
}
