import "server-only";

import type { NextRequest } from "next/server";
import { getUserAbilityForRequest } from "@/server/ability-for-request";
import { getServerAuthSession } from "@/server/auth";

/**
 * Route-handler check: true when the request carries a device token or a
 * session that may create content (contributor or admin).
 */
export async function isContentEditorRequest(request: NextRequest): Promise<boolean> {
  if (request.headers.has("authorization")) {
    const { ability } = await getUserAbilityForRequest(request);
    return ability.can("create", "Content");
  }
  const { session, ability } = await getServerAuthSession();
  return Boolean(session?.user?.id) && ability.can("create", "Content");
}
