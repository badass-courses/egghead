import { NextRequest } from "next/server";
import { Effect, Layer } from "effect";
import { WorkshopFailure } from "@egghead/core/contracts";
import { WorkshopActor } from "@egghead/core/workshops";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { localWorkshopActor } from "@/lib/workshops/local-actor";
import { buildWorkshopMcpServer } from "@/lib/workshops/mcp";
import { assertLocalWorkshopRuntime, workshopStoreLayer } from "@/lib/workshops/mysql-store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const databaseUrl =
    process.env["DATABASE_URL"] ?? "mysql://root:root@127.0.0.1:3307/coursebuilder_test";
  try {
    assertLocalWorkshopRuntime(databaseUrl);
  } catch {
    return Response.json({ error: "Native Workshop MCP is local-only" }, { status: 403 });
  }
  const authenticated = await Effect.runPromise(
    Effect.tryPromise({
      try: () => localWorkshopActor(databaseUrl, request.headers.get("Authorization")),
      catch: () =>
        new WorkshopFailure({
          code: "StoreUnavailable",
          message: "Workshop authentication unavailable",
        }),
    }).pipe(Effect.either),
  );
  if (authenticated._tag === "Left") {
    return Response.json({ error: authenticated.left.message }, { status: 503 });
  }
  const actor = authenticated.right;
  if (!actor) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="egghead-builder"' } },
    );
  }
  const services = Layer.merge(
    Layer.succeed(WorkshopActor, actor),
    workshopStoreLayer(databaseUrl, process.env["NEXT_PUBLIC_APP_NAME"] ?? "egghead"),
  );
  const server = buildWorkshopMcpServer(services);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}

export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
export function DELETE() {
  return GET();
}
