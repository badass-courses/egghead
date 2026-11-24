import { serve } from "inngest/next";

import { inngestConfig } from "../../../inngest/config";
import { isReadOnlyBeta } from "../../../runtime";

const handlers = serve(inngestConfig);

function withoutBeta<Args extends unknown[]>(handler: (...args: Args) => Promise<Response>) {
  return async (...args: Args) =>
    isReadOnlyBeta() ? new Response(null, { status: 404 }) : handler(...args);
}

export const GET = withoutBeta(handlers.GET);
export const POST = withoutBeta(handlers.POST);
export const PUT = withoutBeta(handlers.PUT);
