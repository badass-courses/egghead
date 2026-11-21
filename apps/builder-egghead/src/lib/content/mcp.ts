import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Layer, Schema } from "effect";
import { Approval, CapabilityFailure } from "@egghead/core/capability";
import {
  contentCapabilities,
  ContentActor,
  ContentStore,
  type ContentCapability,
} from "@egghead/core/content";
import type { ContentFailure } from "@egghead/core/contracts/content";

export function buildContentMcpServer(
  services: Layer.Layer<ContentActor | ContentStore, ContentFailure>,
) {
  const server = new Server(
    { name: "egghead-content", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: contentCapabilities.map(({ contract, inputJsonSchema, outputJsonSchema }) => ({
      name: contract.name,
      description: contract.description,
      inputSchema: { ...inputJsonSchema, type: "object" as const },
      outputSchema: { ...outputJsonSchema, type: "object" as const },
      annotations: {
        readOnlyHint: contract.annotations.readOnly,
        idempotentHint: contract.annotations.idempotent,
        destructiveHint: contract.annotations.destructive,
        openWorldHint: contract.annotations.openWorld,
      },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const capability = contentCapabilities.find(({ contract }) => contract.name === params.name);
    if (!capability)
      return { isError: true, content: [{ type: "text", text: "Unknown content capability" }] };
    const result = await Effect.runPromise(
      runCapability(capability, params.arguments ?? {}).pipe(
        Effect.provide(
          Layer.merge(
            services,
            Layer.succeed(Approval, {
              require: () =>
                Effect.fail(
                  new CapabilityFailure({
                    code: "ApprovalDenied",
                    message: "No approval-gated tools in this endpoint",
                  }),
                ),
            }),
          ),
        ),
        Effect.either,
      ),
    );
    if ("left" in result)
      return { isError: true, content: [{ type: "text", text: JSON.stringify(result.left) }] };
    return {
      structuredContent: result.right,
      content: [{ type: "text", text: JSON.stringify(result.right, null, 2) }],
    };
  });
  return server;
}
function runCapability(capability: ContentCapability, input: unknown) {
  return Effect.gen(function* () {
    const result = yield* capability.run(input);
    return yield* Schema.encode(Schema.Record({ key: Schema.String, value: Schema.Unknown }))(
      result,
    ).pipe(
      Effect.mapError(
        () => new CapabilityFailure({ code: "InvalidOutput", message: "Invalid content result" }),
      ),
    );
  });
}
