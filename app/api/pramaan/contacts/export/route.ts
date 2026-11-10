import { exportContacts } from "../../../../../lib/pramaan/contacts";
import { crmRoute } from "../../../../../lib/pramaan/crm-data";
export async function GET(request: Request) {
  const result = await crmRoute(request, exportContacts);
  if (!result.ok) return result;
  return new Response(await result.json(), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=contacts.csv",
      "cache-control": "no-store",
    },
  });
}
