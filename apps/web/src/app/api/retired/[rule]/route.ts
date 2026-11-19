import { retiredRouteById } from "../../../../routing/legacy-redirects";
import { retiredRouteResponse } from "../../../../routing/retired-response";

// Legacy egghead.io URLs that were deliberately retired land here through a
// beforeFiles rewrite in next.config.ts. The table lives in
// src/routing/legacy-redirects.ts.
async function retired(_request: Request, context: { params: Promise<{ rule: string }> }) {
  const { rule } = await context.params;
  return retiredRouteResponse(retiredRouteById(rule));
}

export const GET = retired;
export const POST = retired;
