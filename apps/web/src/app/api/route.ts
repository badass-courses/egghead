import {
  commerceWritesAreAllowed,
  getEggheadRuntime,
  isBetaDatabaseApproved,
} from "../../db/local-docker";

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
        commerce: {
          pricing: "/pricing",
          stripeWebhook: "/api/coursebuilder/webhook/stripe",
          inngest: "/api/inngest",
        },
        auth: {
          currentUser: "/api/current-user",
        },
      },
      guardrails: {
        runtime,
        betaDatabaseApproved: isBetaDatabaseApproved(),
        commerceWritesAllowed: commerceWritesAreAllowed(),
        productionDatabaseRequired: runtime === "production",
      },
    },
    {
      headers: {
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
      },
    },
  );
}
