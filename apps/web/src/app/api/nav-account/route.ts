import { connection } from "next/server";

import { getCurrentUserWithAccess } from "../../../coursebuilder/current-user";
import { navAccountResponse, navAccountState } from "../../../coursebuilder/nav-account";

// Per-request on purpose: connection() keeps this handler out of the build's
// prerender even if the session read stops touching request data. The build
// output must list /api/nav-account as dynamic (ƒ); the HTTP smoke checks the
// signed-out and signed-in shapes.
// Signed out is a normal 200 with the anonymous shape, not a 401.
export async function GET() {
  await connection();
  return navAccountResponse(navAccountState(await getCurrentUserWithAccess()));
}
