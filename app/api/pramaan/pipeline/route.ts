import { connection } from "next/server";
import { crmRoute } from "../../../../lib/pramaan/crm-data";
import { getPipeline, updatePipeline } from "../../../../lib/pramaan/pipeline";
export async function GET(request: Request) {
  await connection();
  return crmRoute(request, (scope) => getPipeline(scope));
}
export async function POST(request: Request) {
  return crmRoute(request, (scope, body) => updatePipeline(scope, body));
}
