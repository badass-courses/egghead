import { handleShadowRequest } from "../../../../subscriptions/shadow/handler";
import { shadowDependencies } from "../../../../subscriptions/shadow/configuration";

// Cache Components forbids a runtime segment export; use Next's Node.js default.
/** The desk exempts this exact POST path only, never /api/* or the CB writer route. */
export async function POST(request: Request) {
  return handleShadowRequest(request, process.env["STRIPE_SHADOW_WEBHOOK_SECRET"], () =>
    shadowDependencies(process.env),
  );
}
