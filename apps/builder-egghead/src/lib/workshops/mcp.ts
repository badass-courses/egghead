import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Layer, Schema } from "effect";
import { Approval, CapabilityFailure } from "@egghead/core/capability";
import type { WorkshopFailure } from "@egghead/core/contracts";
import {
  capabilities,
  WorkshopActor,
  WorkshopStore,
  type WorkshopCapability,
} from "@egghead/core/workshops";

/** Transport policy only: schemas, metadata, approval, and behavior belong to capabilities. */
export function buildWorkshopMcpServer(
  services: Layer.Layer<WorkshopActor | WorkshopStore, WorkshopFailure>,
) {
  const server = new Server(
    { name: "egghead-native-workshops", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: capabilities.map(({ contract, inputJsonSchema, outputJsonSchema }) => ({
      name: contract.name,
      description: contract.description,
      inputSchema: {
        ...inputJsonSchema,
        type: "object" as const,
        ...(contract.needsApproval
          ? {
              properties: {
                ...("properties" in inputJsonSchema ? inputJsonSchema.properties : {}),
                confirm: {
                  type: "boolean",
                  description: "Must be true after the operator approves the preview.",
                },
              },
            }
          : {}),
      },
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
    const capability = capabilities.find(({ contract }) => contract.name === params.name);
    if (!capability)
      return { isError: true, content: [{ type: "text", text: "Unknown Workshop capability" }] };
    const argumentsInput = params.arguments ?? {};
    const { confirm, ...input } = argumentsInput;
    const approval = Layer.succeed(Approval, {
      require: () =>
        confirm === true
          ? Effect.void
          : Effect.fail(
              new CapabilityFailure({
                code: "ApprovalDenied",
                message: `Preview with preview_${params.name}, then confirm explicitly`,
              }),
            ),
    });
    const result = await Effect.runPromise(
      runCapability(capability, input).pipe(
        Effect.provide(Layer.merge(services, approval)),
        Effect.either,
      ),
    );
    if (result._tag === "Left")
      return { isError: true, content: [{ type: "text", text: JSON.stringify(result.left) }] };
    return {
      structuredContent: result.right,
      content: [{ type: "text", text: JSON.stringify(result.right, null, 2) }],
    };
  });
  return server;
}

function runCapability(capability: WorkshopCapability, input: unknown) {
  return Effect.gen(function* () {
    const result = yield* capability.run(input);
    // Each capability validates its own output; this schema only supplies a JSON-safe object to MCP.
    return yield* Schema.encode(Schema.Record({ key: Schema.String, value: Schema.Unknown }))(
      result,
    ).pipe(
      Effect.mapError(
        () =>
          new CapabilityFailure({ code: "InvalidOutput", message: "Invalid capability result" }),
      ),
    );
  });
}
