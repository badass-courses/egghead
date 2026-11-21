import { NextRequest } from "next/server";
import { Layer } from "effect";
import { ContentActor } from "@egghead/core/content";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getUserAbilityForRequest } from "@/server/ability-for-request";
import { contentActor } from "@/lib/content/actor";
import { buildContentMcpServer } from "@/lib/content/mcp";
import { courseBuilderContentStore } from "@/lib/content/coursebuilder-store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  let actor: ReturnType<typeof contentActor>;
  try {
    const identity = await getUserAbilityForRequest(request);
    actor = contentActor(identity.user ? identity : null, request.headers.get("X-Actor-Label"));
  } catch {
    return Response.json({ error: "Content authentication unavailable" }, { status: 503 });
  }
  if (!actor)
    return Response.json(
      { error: "A valid device token and X-Actor-Label are required" },
      {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="egghead-builder"' },
      },
    );
  const server = buildContentMcpServer(
    Layer.merge(Layer.succeed(ContentActor, actor), courseBuilderContentStore()),
  );
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
