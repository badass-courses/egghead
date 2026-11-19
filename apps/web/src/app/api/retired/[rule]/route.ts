import { retiredRouteById } from "../../../../routing/legacy-redirects";
import { retiredRouteResponse } from "../../../../routing/retired-response";

// Legacy egghead.io URLs that were deliberately retired land here through a
// beforeFiles rewrite in next.config.ts. The table lives in
// src/routing/legacy-redirects.ts. Every method answers 410, so old API
// callers never see a 405. Next derives HEAD from GET.
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
