import {
  getEggheadRuntime,
  getRuntimeOperationPermissions,
  isBetaDatabaseApproved,
} from "../../db/local-docker";
import { courseBuilderHttpOperations } from "../../coursebuilder/http-policy";

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
        localDevOnly: runtime === "local",
        betaRuntime: runtime === "beta",
        betaDatabaseApproved: isBetaDatabaseApproved(),
        operationPermissions: getRuntimeOperationPermissions(),
        permissionEvidence: "application policy; database privileges not probed",
        courseBuilderHttpOperations,
        betaAccountWritesRequireSeparateApproval: true,
        betaProgressWritesRequireSeparateApproval: true,
        commerceWritesLocalOnly: true,
        subscriptionManagementLocalOnly: true,
        noReadFlip: true,
        indexingRequiresSeparateApproval: true,
      },
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
