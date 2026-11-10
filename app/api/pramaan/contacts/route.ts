import { connection } from "next/server";
import { getContacts, updateContacts } from "../../../../lib/pramaan/contacts";
import { crmRoute } from "../../../../lib/pramaan/crm-data";
export async function GET(request: Request) {
  await connection();
  const search = new URL(request.url).searchParams.get("search") ?? "";
  return crmRoute(request, (scope) => getContacts(scope, search));
}
export async function POST(request: Request) {
  return crmRoute(request, (scope, body) => updateContacts(scope, body));
}
