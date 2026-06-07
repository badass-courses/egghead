import { getCurrentUserFromRequest } from "../../../coursebuilder/current-user";

export async function GET(request: Request) {
  const currentUser = await getCurrentUserFromRequest(request);

  return Response.json({
    user: currentUser.user,
    source: "egghead-standalone-app",
    requestTimeRailsFallback: false,
    compatibility: currentUser.compatibility,
  });
}
