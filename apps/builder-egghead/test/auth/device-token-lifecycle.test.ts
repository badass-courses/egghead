import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";
import { DEVICE_ACCESS_TOKEN_TTL_SECONDS } from "../../src/server/device-token-policy";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  grant: vi.fn(),
  user: vi.fn(),
  token: vi.fn(),
  consume: vi.fn(),
  insert: vi.fn(),
  revoke: vi.fn(),
  session: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/server/auth", () => ({ getServerAuthSession: mocks.session }));
vi.mock("@/db", () => ({
  db: {
    transaction: mocks.transaction,
    query: { deviceAccessToken: { findFirst: mocks.token } },
    update: () => ({ set: () => ({ where: mocks.revoke }) }),
  },
  courseBuilderAdapter: { getContentResource: vi.fn(), getVideoResource: vi.fn() },
}));
vi.mock("@/lib/posts-query", () => ({
  getPost: vi.fn(),
  getAllPostsForUser: vi.fn(),
  deletePostFromDatabase: vi.fn(),
  writePostUpdateToDatabase: vi.fn(),
  updatePostTags: vi.fn(),
}));
vi.mock("@/lib/posts", () => ({ NewPostSchema: {}, PostActionSchema: {}, PostUpdateSchema: {} }));
vi.mock("@/lib/posts-new-query", () => ({ writeNewPostToDatabase: vi.fn() }));
vi.mock("@/lib/egghead", () => ({ getEggheadUserProfile: vi.fn() }));
vi.mock("@/lib/tags", () => ({ EggheadTagSchema: {} }));
vi.mock("@/lib/tags-query", () => ({ getAllEggheadTagsCached: vi.fn() }));
vi.mock("@/inngest/inngest.server", () => ({ inngest: { send: vi.fn() } }));
import { POST as issue } from "../../src/app/oauth/token/route";
import { POST as revoke } from "../../src/app/oauth/revoke/route";
import { GET as userinfo } from "../../src/app/oauth/userinfo/route";
import * as posts from "../../src/app/api/posts/route";
import { POST as content } from "../../src/app/api/content-mcp/route";
import { GET as tags } from "../../src/app/api/tags/route";
import { POST as tagPost } from "../../src/app/api/tags/[postId]/route";
import { GET as video } from "../../src/app/api/videos/[videoResourceId]/route";
import { POST as upload } from "../../src/app/api/uploads/new/route";
import { isContentEditorRequest } from "../../src/server/editor-for-request";

const person = {
  id: "author",
  name: "Synthetic Author",
  roles: [
    {
      active: true,
      deletedAt: null,
      role: {
        id: "contributor",
        name: "contributor",
        description: null,
        active: true,
        createdAt: null,
        updatedAt: null,
        deletedAt: null,
      },
    },
  ],
};
type Token = {
  token: string;
  userId: string;
  createdAt: Date;
  scope: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
};
let grant: {
  deviceCode: string;
  expires: Date;
  verifiedAt: Date | null;
  verifiedByUserId: string | null;
} | null;
const tokens = new Map<string, Token>();
const param = (where: SQL, index = 0): unknown =>
  new MySqlDialect().sqlToQuery(where).params[index];
const request = (path: string, token: string, method = "GET") =>
  new NextRequest(`https://example.invalid${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "X-Actor-Label": "lifecycle-test" },
  });
const exchange = () =>
  issue(
    new Request("https://example.invalid/oauth/token", {
      method: "POST",
      body: new URLSearchParams({ device_code: "grant" }),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  tokens.clear();
  grant = {
    deviceCode: "grant",
    expires: new Date(Date.now() + 60000),
    verifiedAt: new Date(),
    verifiedByUserId: person.id,
  };
  mocks.grant.mockImplementation(async ({ where }: { where: SQL }) =>
    param(where) === grant?.deviceCode ? grant : undefined,
  );
  mocks.user.mockResolvedValue(person);
  mocks.consume.mockImplementation(async (where: SQL) => {
    if (
      !grant ||
      param(where) !== grant.deviceCode ||
      param(where, 1) !== grant.verifiedByUserId ||
      !grant.verifiedAt ||
      grant.expires <= new Date()
    )
      return { rowsAffected: 0 };
    grant = null;
    return { rowsAffected: 1 };
  });
  mocks.insert.mockImplementation(async (row: Token) => {
    tokens.set(row.token, row);
  });
  mocks.transaction.mockImplementation(async (run: (tx: unknown) => Promise<Response>) =>
    run({
      query: { deviceVerifications: { findFirst: mocks.grant }, users: { findFirst: mocks.user } },
      delete: () => ({ where: mocks.consume }),
      insert: () => ({ values: mocks.insert }),
    }),
  );
  mocks.token.mockImplementation(async ({ where }: { where: SQL }) => {
    const key = param(where);
    const row = typeof key === "string" ? tokens.get(key) : undefined;
    return row ? { ...row, verifiedBy: person } : undefined;
  });
  mocks.revoke.mockImplementation(async (where: SQL) => {
    const key = param(where);
    const row = typeof key === "string" ? tokens.get(key) : undefined;
    if (!row || row.userId !== param(where, 1)) return { rowsAffected: 0 };
    row.revokedAt = new Date();
    return { rowsAffected: 1 };
  });
});
afterEach(() => vi.restoreAllMocks());

async function expectBearerDenied(token: string) {
  const results = await Promise.all([
    userinfo(request("/oauth/userinfo", token)),
    posts.GET(request("/api/posts?slug=not-read", token)),
    posts.POST(request("/api/posts", token, "POST")),
    posts.PUT(request("/api/posts", token, "PUT")),
    posts.DELETE(request("/api/posts?id=not-deleted", token, "DELETE")),
    content(request("/api/content-mcp", token, "POST")),
    tags(request("/api/tags", token)),
    tagPost(request("/api/tags/post", token, "POST"), {
      params: Promise.resolve({ postId: "post" }),
    }),
    video(request("/api/videos/video", token), {
      params: Promise.resolve({ videoResourceId: "video" }),
    }),
    upload(request("/api/uploads/new", token, "POST")),
    revoke(request("/oauth/revoke", token, "POST")),
  ]);
  expect(results.map((response) => response.status)).toEqual(
    Array.from({ length: results.length }, () => 401),
  );
  expect(await isContentEditorRequest(request("/api/uploads/signed-url", token, "POST"))).toBe(
    false,
  );
  expect(mocks.session).not.toHaveBeenCalled();
}

describe("device token lifecycle through the real handlers", () => {
  it("returns the exact newly inserted token, bounds expiry, uses it, revokes it, then refuses every bearer path", async () => {
    tokens.set("older-token", {
      token: "older-token",
      userId: person.id,
      createdAt: new Date(),
      scope: "",
      expiresAt: null,
      revokedAt: null,
    });
    const response = await exchange();
    expect(response.status).toBe(200);
    const result: unknown = await response.json();
    expect(result).toMatchObject({
      expires_in: DEVICE_ACCESS_TOKEN_TTL_SECONDS,
      token_type: "bearer",
    });
    if (
      !result ||
      typeof result !== "object" ||
      !("access_token" in result) ||
      typeof result.access_token !== "string"
    )
      throw new Error("Missing issued token");
    const issued = tokens.get(result.access_token);
    expect(issued?.token).not.toBe("older-token");
    expect(issued?.expiresAt?.getTime()).toBe(
      (issued?.createdAt.getTime() ?? 0) + DEVICE_ACCESS_TOKEN_TTL_SECONDS * 1000,
    );
    expect((await userinfo(request("/oauth/userinfo", result.access_token))).status).toBe(200);
    expect((await revoke(request("/oauth/revoke", result.access_token, "POST"))).status).toBe(204);
    expect(tokens.get("older-token")?.revokedAt).toBeNull();
    await expectBearerDenied(result.access_token);
    expect((await exchange()).status).toBe(403);
  });
  it("expires a fixture token, then refuses every bearer path", async () => {
    tokens.set("expired", {
      token: "expired",
      userId: person.id,
      createdAt: new Date(),
      scope: "",
      expiresAt: new Date(Date.now() - 1),
      revokedAt: null,
    });
    await expectBearerDenied("expired");
  });
  it("keeps legacy NULL expiry usable and revocable", async () => {
    tokens.set("legacy", {
      token: "legacy",
      userId: person.id,
      createdAt: new Date(),
      scope: "",
      expiresAt: null,
      revokedAt: null,
    });
    expect((await userinfo(request("/oauth/userinfo", "legacy"))).status).toBe(200);
    expect((await revoke(request("/oauth/revoke", "legacy", "POST"))).status).toBe(204);
    await expectBearerDenied("legacy");
  });
  it("junk bearer returns 401, not 500, before any resource operation", async () => {
    await expectBearerDenied("junk");
  });
  it("lookup errors fail closed and log only a fixed reason", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.token.mockRejectedValue(new Error("database error contains synthetic-secret-value"));
    await expectBearerDenied("synthetic-secret-value");
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: "device_authentication_denied", reason: "lookup_failed" }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-secret-value");
  });
  it("only one concurrent exchange can consume an approved grant", async () => {
    const results = await Promise.all([exchange(), exchange()]);
    expect(results.map((response) => response.status).toSorted()).toEqual([200, 403]);
    expect(tokens.size).toBe(1);
  });
  it.each(["pending", "expired-approved", "unknown", "unverified-user"])(
    "refuses a %s grant without minting",
    async (state) => {
      if (!grant) throw new Error("Missing fixture");
      if (state === "pending") grant.verifiedAt = null;
      if (state === "expired-approved") grant.expires = new Date(Date.now() - 1);
      if (state === "unknown") grant = null;
      if (state === "unverified-user" && grant) grant.verifiedByUserId = null;
      expect((await exchange()).status).toBe(403);
      expect(tokens.size).toBe(0);
    },
  );
});
