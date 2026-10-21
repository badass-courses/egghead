import { Schema } from "effect";
import {
  getWorkshopContract,
  listWorkshopsContract,
  WorkshopFailure,
} from "@egghead/core/contracts";

import { getEnv } from "../env";

// A development-only reader for the same authenticated capabilities used by chat.
export function localWorkshopConnection() {
  if (process.env["NODE_ENV"] !== "development" || getEnv("EGGHEAD_RUNTIME") !== "local")
    return null;
  const address = getEnv("WORKSHOP_MCP_URL");
  const token = getEnv("WORKSHOP_MCP_TOKEN");
  if (!address || !token || !URL.canParse(address)) return null;
  const url = new URL(address);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.pathname !== "/api/workshop-mcp" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return null;
  return { url: url.toString(), token };
}

type WorkshopViewer = { id: string; role: string };

export function canPreviewLocalWorkshops(viewer: WorkshopViewer | null): viewer is WorkshopViewer {
  return Boolean(viewer?.id && (viewer.role === "admin" || viewer.role === "contributor"));
}

function canViewWorkshop(viewer: WorkshopViewer | null, workshop: { createdById: string }) {
  return (
    canPreviewLocalWorkshops(viewer) &&
    (viewer.role === "admin" || workshop.createdById === viewer.id)
  );
}

const ToolResponse = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.optional(Schema.Boolean),
    structuredContent: Schema.optional(Schema.Unknown),
    content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })),
  }),
});

async function readTool(
  contract: typeof getWorkshopContract | typeof listWorkshopsContract,
  input: object,
  viewer: WorkshopViewer | null,
) {
  if (!canPreviewLocalWorkshops(viewer)) {
    throw new WorkshopFailure({
      code: "Unauthorized",
      message: "Workshop preview requires a staff session",
    });
  }
  const connection = localWorkshopConnection();
  if (!connection) throw new Error("Local Workshop preview is not configured");
  const response = await fetch(connection.url, {
    method: "POST",
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
    headers: {
      Authorization: `Bearer ${connection.token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: contract.name, arguments: input },
    }),
  });
  if (!response.ok) throw new Error("Local Workshop server is unavailable or unauthorized");
  const body: unknown = await response.json();
  const { result } = Schema.decodeUnknownSync(ToolResponse)(body);
  if (result.isError) {
    const failure = Schema.decodeUnknownSync(Schema.parseJson(WorkshopFailure))(
      result.content[0]?.text,
    );
    throw failure;
  }
  return result.structuredContent;
}

export async function listLocalWorkshops(viewer: WorkshopViewer | null, cursor?: string) {
  const input = Schema.decodeUnknownSync(listWorkshopsContract.input)({ limit: 20, cursor });
  const page = Schema.decodeUnknownSync(listWorkshopsContract.output)(
    await readTool(listWorkshopsContract, input, viewer),
  );
  return {
    ...page,
    workshops: page.workshops.filter((workshop) => canViewWorkshop(viewer, workshop)),
  };
}

export async function getLocalWorkshop(id: string, viewer: WorkshopViewer | null) {
  const input = Schema.decodeUnknownSync(getWorkshopContract.input)({ id });
  try {
    const workshop = Schema.decodeUnknownSync(getWorkshopContract.output)(
      await readTool(getWorkshopContract, input, viewer),
    );
    return canViewWorkshop(viewer, workshop) ? workshop : null;
  } catch (error) {
    if (error instanceof WorkshopFailure && error.code === "NotFound") return null;
    throw error;
  }
}
