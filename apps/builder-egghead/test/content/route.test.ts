import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getAbility } from "../../src/ability";
import { authenticateDevice } from "../../src/server/device-identity";
import { contentStoreLayer } from "../../src/lib/content/store";
import { decideAccess } from "../../src/server/access-policy";

const { identityLookup, storeOpened } = vi.hoisted(() => ({
  identityLookup: vi.fn(),
  storeOpened: vi.fn(),
}));
vi.mock("@/server/ability-for-request", () => ({ getUserAbilityForRequest: identityLookup }));
vi.mock("@/lib/content/coursebuilder-store", () => ({
  courseBuilderContentStore: () => {
    storeOpened();
    return contentStoreLayer({
      read: async () => {
        throw new Error("Unexpected database read");
      },
      list: async () => {
        throw new Error("Unexpected database list");
      },
      create: async () => {
        throw new Error("Unexpected database write");
      },
      compareAndSwap: async () => {
        throw new Error("Unexpected database write");
      },
    });
  },
}));
import { DELETE, GET, POST } from "../../src/app/api/content-mcp/route";

afterEach(() => vi.resetAllMocks());
const request = (actorLabel?: string) =>
  new NextRequest("https://example.invalid/api/content-mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer synthetic-token",
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25",
      ...(actorLabel ? { "X-Actor-Label": actorLabel } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
it("HTTP refuses unauthenticated calls and invalid agent labels before opening the store", async () => {
  identityLookup.mockResolvedValue({ user: null, ability: getAbility(), tokenId: null });
  expect((await POST(request("agent"))).status).toBe(401);
  const identity = await authenticateDevice("Bearer synthetic-token", async () => ({
    revokedAt: null,
    expiresAt: null,
    verifiedBy: {
      id: "author",
      roles: [
        {
          active: true,
          deletedAt: null,
          role: {
            id: "r",
            name: "contributor",
            active: true,
            deletedAt: null,
            description: null,
            createdAt: null,
            updatedAt: null,
          },
        },
      ],
    },
  }));
  identityLookup.mockResolvedValue(identity);
  expect((await POST(request())).status).toBe(401);
  expect(storeOpened).not.toHaveBeenCalled();
  const response = await POST(request("test-agent"));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    result: {
      tools: [
        { name: "list_posts" },
        { name: "get_post" },
        { name: "create_draft" },
        { name: "update_draft" },
      ],
    },
  });
  expect(storeOpened).toHaveBeenCalledOnce();
});
it("HTTP fails closed on identity service failure and refuses GET/DELETE", async () => {
  identityLookup.mockRejectedValue(new Error("offline"));
  expect((await POST(request("agent"))).status).toBe(503);
  expect(storeOpened).not.toHaveBeenCalled();
  expect(GET().status).toBe(405);
  expect(DELETE().status).toBe(405);
});
it("proxy delegates only bearer content MCP calls, without weakening editor action rules", () => {
  const anonymous = { signedIn: false, roles: [], hasBearer: false };
  expect(decideAccess("/api/content-mcp", anonymous)).toBe("deny");
  expect(decideAccess("/api/content-mcp", { ...anonymous, hasBearer: true })).toBe("allow");
  expect(decideAccess("/api/content-mcp-other", { ...anonymous, hasBearer: true })).toBe("deny");
  expect(
    decideAccess("/api/content-mcp", { ...anonymous, hasBearer: true, serverAction: true }),
  ).toBe("deny");
});
