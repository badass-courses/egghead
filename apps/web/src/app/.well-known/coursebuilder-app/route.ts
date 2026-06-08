import { getBaseUrl } from "../../../coursebuilder/url";
import { getEggheadRuntime, isBetaDatabaseApproved } from "../../../db/local-docker";

export function GET(request: Request) {
  const baseUrl = getBaseUrl(request);
  const runtime = getEggheadRuntime();

  return Response.json({
    id: "egghead",
    displayName: "egghead",
    baseUrl,
    runtime,
    auth: {
      currentUser: "/api/current-user",
    },
    capabilities: {
      content: {
        api: "/api",
        coursebuilder: "/api/coursebuilder",
      },
      phase0: {
        localOnly: runtime === "local",
        betaRuntime: runtime === "beta",
        betaDatabaseApproved: isBetaDatabaseApproved(),
        commerceExcluded: true,
        stripeWriterUnchanged: true,
        inngestWriterUnchanged: true,
        readFlipBlocked: true,
      },
    },
    _links: {
      self: "/.well-known/coursebuilder-app",
      api: "/api",
      coursebuilder: "/api/coursebuilder/session",
      currentUser: "/api/current-user",
    },
    next_actions: [
      {
        command: "bun tools/me.ts egghead standalone check --url http://localhost:3008 --json",
        description: "Run local Phase 0 standalone boundary checks from migrate-egghead",
      },
    ],
  });
}
