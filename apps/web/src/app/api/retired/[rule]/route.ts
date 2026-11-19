import { retiredRouteById } from "../../../../routing/legacy-redirects";
import { retiredRouteResponse } from "../../../../routing/retired-response";

// Legacy egghead.io URLs that were deliberately retired land here through a
// beforeFiles rewrite in next.config.ts. The table lives in
// src/routing/legacy-redirects.ts. Every method answers 410, so old API
// callers never see a 405. Next derives HEAD from GET.
//
// OPTIONS answers 410 too, with no CORS headers. A browser preflight fails on
// any response without Access-Control-Allow-*, so a 204 would fail the same
// cross-origin caller and only tell non-browser clients the endpoint is
// alive. Adding CORS headers would invite calls to a dead endpoint.
async function retired(_request: Request, context: { params: Promise<{ rule: string }> }) {
  const { rule } = await context.params;
  return retiredRouteResponse(retiredRouteById(rule));
}

export const GET = retired;
export const POST = retired;
export const PUT = retired;
export const PATCH = retired;
export const DELETE = retired;
export const OPTIONS = retired;
