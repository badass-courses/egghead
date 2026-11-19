import { getCurrentUserWithAccess } from "../../../coursebuilder/current-user";
import { navAccountResponse, navAccountState } from "../../../coursebuilder/nav-account";

// Signed out is a normal 200 with the anonymous shape, not a 401.
export async function GET() {
  return navAccountResponse(navAccountState(await getCurrentUserWithAccess()));
}
