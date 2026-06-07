import { getCurrentUser } from "@/coursebuilder/current-user";

export async function GET() {
  const user = await getCurrentUser();

  return Response.json({
    user,
    source: "egghead-standalone-app",
    requestTimeRailsFallback: false,
    compatibility: {
      anonymousReturnsNullUser: true,
    },
  });
}
