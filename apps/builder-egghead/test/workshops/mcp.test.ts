import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { capabilities, WorkshopActor, WorkshopStore } from "@egghead/core/workshops";
import { WorkshopFailure } from "@egghead/core/contracts";
import { buildWorkshopMcpServer } from "../../src/lib/workshops/mcp";
import { assertLocalWorkshopRuntime } from "../../src/lib/workshops/mysql-store";

it.effect(
  "MCP discovers contract schemas, requires confirmation, and calls the shared handler",
  () => {
    let writes = 0;
    const services = Layer.merge(
      Layer.succeed(WorkshopActor, {
        id: "instructor",
        canCreate: true,
        canManageAll: false,
        canManage: (workshop) => workshop.createdById === "instructor",
      }),
      Layer.succeed(WorkshopStore, {
        get: () => Effect.succeed(null),
        canPublish: () => Effect.succeed(false),
        publish: () => Effect.fail(new WorkshopFailure({code:"NotFound",message:"Workshop not found"})),
        list: () => Effect.succeed({ workshops: [], nextCursor: null }),
        create: (workshop) =>
          Effect.sync(() => {
            writes++;
            return workshop;
          }),
        revise: () =>
          Effect.fail(new WorkshopFailure({ code: "NotFound", message: "Workshop not found" })),
      }),
    );
    return Effect.tryPromise(async () => {
      const server = buildWorkshopMcpServer(services);
      const client = new Client({ name: "workshop-contract-test", version: "1.0.0" });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const catalog = await client.listTools();
        expect(catalog.tools.map((tool) => tool.name)).toEqual(
          capabilities.map(({ contract }) => contract.name),
        );
        const writeTool = catalog.tools.find((tool) => tool.name === "create_workshop");
        expect(writeTool?.annotations?.readOnlyHint).toBe(false);
        expect(writeTool?.inputSchema.properties).toHaveProperty("requestId");
        expect(writeTool?.inputSchema.properties).toHaveProperty("confirm");
        expect(writeTool?.inputSchema.properties).not.toHaveProperty("flagKey");
        const input = {
          requestId: "fab7fa45-05c2-49e4-af34-3e65d2b25fe1",
          title: "Native Workshop",
          description: "",
          startsAt: "2026-11-02T16:00:00Z",
          endsAt: "2026-11-02T18:00:00Z",
          timezone: "America/Denver",
          attendeeInstructions: "",
        };
        const preview = await client.callTool({
          name: "preview_create_workshop",
          arguments: input,
        });
        expect(preview.isError).not.toBe(true);
        expect(writes).toBe(0);
        const denied = await client.callTool({ name: "create_workshop", arguments: input });
        expect(denied.isError).toBe(true);
        expect(JSON.stringify(denied)).toContain("ApprovalDenied");
        expect(writes).toBe(0);
        const created = await client.callTool({
          name: "create_workshop",
          arguments: { ...input, confirm: true },
        });
        expect(created.isError).not.toBe(true);
        expect(created.structuredContent).toEqual(preview.structuredContent);
        expect(writes).toBe(1);
      } finally {
        await client.close();
        await server.close();
      }
    });
  },
);

it("blocks beta and production before the native Workshop database opens", () => {
  const previous = process.env["EGGHEAD_RUNTIME"];
  try {
    process.env["EGGHEAD_RUNTIME"] = "local";
    expect(() =>
      assertLocalWorkshopRuntime("mysql://root:root@localhost:3307/coursebuilder_test"),
    ).not.toThrow();
    expect(() =>
      assertLocalWorkshopRuntime("mysql://user:password@aws.connect.psdb.cloud/test"),
    ).toThrow();
    process.env["EGGHEAD_RUNTIME"] = "beta";
    expect(() =>
      assertLocalWorkshopRuntime("mysql://root:root@localhost:3307/coursebuilder_test"),
    ).toThrow();
    process.env["EGGHEAD_RUNTIME"] = "production";
    expect(() =>
      assertLocalWorkshopRuntime("mysql://root:root@localhost:3307/coursebuilder_test"),
    ).toThrow();
  } finally {
    if (previous === undefined) delete process.env["EGGHEAD_RUNTIME"];
    else process.env["EGGHEAD_RUNTIME"] = previous;
  }
});
