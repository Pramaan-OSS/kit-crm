import { connection } from "next/server";
import { crmRoute } from "../../../../lib/pramaan/crm-data";
import { getPipeline, updatePipeline } from "../../../../lib/pramaan/pipeline";
export async function GET(request: Request) {
  await connection();
  const params = new URL(request.url).searchParams;
  const filter = {
    stage: params.get("stage") ?? undefined,
    sort: params.get("sort") ?? undefined,
  };
  return crmRoute(request, (scope) => getPipeline(scope, filter));
}
export async function POST(request: Request) {
  return crmRoute(request, (scope, body) => updatePipeline(scope, body));
}
