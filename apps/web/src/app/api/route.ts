import { getEggheadRuntime, isBetaDatabaseApproved } from "../../db/local-docker";

export function GET() {
  const runtime = getEggheadRuntime();

  return Response.json(
    {
      id: "egghead",
      displayName: "egghead",
      description: "egghead CourseBuilder API entrypoint",
      _links: {
        self: "/api",
        discovery: "/.well-known/coursebuilder-app",
        coursebuilder: "/api/coursebuilder/session",
        currentUser: "/api/current-user",
        dbHealth: "/api/health/db",
      },
      capabilities: {
        content: {
          coursebuilder: "/api/coursebuilder",
        },
        auth: {
          currentUser: "/api/current-user",
        },
      },
      guardrails: {
        runtime,
        localDevOnly: runtime === "local",
        betaRuntime: runtime === "beta",
        betaDatabaseApproved: isBetaDatabaseApproved(),
        noCommerce: true,
        noStripeWriterChange: true,
        noInngestWriterChange: true,
        noReadFlip: true,
        noPlanetScaleWrites: true,
      },
    },
    {
      headers: {
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
      },
    },
  );
}
