import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { authenticateDevice, type DeviceIdentityRow } from "../../src/server/device-identity";
import { contentActor } from "../../src/lib/content/actor";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("@/db", () => ({ db: { query: { deviceAccessToken: { findFirst: lookup } } } }));
import { getUserAbilityForRequest } from "../../src/server/ability-for-request";

const now = Date.now();
const role = {
  id: "role",
  name: "contributor",
  description: null,
  active: true,
  createdAt: null,
  updatedAt: null,
  deletedAt: null,
};
const valid: DeviceIdentityRow = {
  revokedAt: null,
  expiresAt: new Date(now + 60000),
  verifiedBy: {
    id: "author",
    name: "Synthetic Author",
    roles: [{ active: true, deletedAt: null, role }],
  },
};
afterEach(() => vi.clearAllMocks());
describe("shared device identity", () => {
  it.each([null, "", "Basic secret", "Bearer", "Bearer secret extra"])(
    "refuses malformed bearer %s without a lookup",
    async (bearer) => {
      const find = vi.fn(async () => valid);
      expect(await authenticateDevice(bearer, find, now)).toBeNull();
      expect(find).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["unknown", undefined],
    ["revoked", { ...valid, revokedAt: new Date(now) }],
    ["expires now", { ...valid, expiresAt: new Date(now) }],
    ["expired", { ...valid, expiresAt: new Date(now - 1) }],
    ["unverified", { ...valid, verifiedBy: null }],
  ] as const)("refuses %s tokens", async (_label, row) => {
    expect(await authenticateDevice("Bearer synthetic-token", async () => row, now)).toBeNull();
  });
  it.each([
    { roles: [] },
    { roles: [{ active: false, deletedAt: null, role }] },
    { roles: [{ active: true, deletedAt: new Date(), role }] },
    { roles: [{ active: true, deletedAt: null, role: { ...role, active: false } }] },
    { roles: [{ active: true, deletedAt: null, role: { ...role, deletedAt: new Date() } }] },
  ])("requires live role assignments from the database: %j", async ({ roles }) => {
    expect(
      await authenticateDevice(
        "Bearer synthetic-token",
        async () => ({
          ...valid,
          verifiedBy: { id: "author", role: "admin", roles },
        }),
        now,
      ),
    ).toBeNull();
  });
  it("derives permissions and a non-secret token identity, validates agent label", async () => {
    const identity = await authenticateDevice("Bearer synthetic-token", async () => valid, now);
    expect(identity?.tokenId).toMatch(/^[a-f0-9]{64}$/);
    expect(identity?.tokenId).not.toContain("synthetic-token");
    expect(contentActor(identity, null)).toBeNull();
    expect(contentActor(identity, "bad\nlabel")).toBeNull();
    const actor = contentActor(identity, "test-agent");
    expect(actor).toMatchObject({
      userId: "author",
      actorLabel: "test-agent",
      canCreate: true,
      canManageAll: false,
    });
    const post = {
      id: "post",
      type: "post" as const,
      createdById: "author",
      fields: { title: "Draft", slug: "draft", state: "draft", postType: "lesson" },
    };
    expect(actor?.canManage(post)).toBe(true);
    expect(actor?.canManage({ ...post, createdById: "other" })).toBe(false);
    expect(actor?.canRead(post)).toBe(true);
  });
  it("authenticates a live token without granting create or manage to a learner", async () => {
    const identity = await authenticateDevice(
      "Bearer synthetic-token",
      async () => ({
        ...valid,
        verifiedBy: {
          id: "learner",
          roles: [{ active: true, deletedAt: null, role: { ...role, name: "learner" } }],
        },
      }),
      now,
    );
    expect(contentActor(identity, "test-agent")).toMatchObject({ canCreate: false });
    expect(
      contentActor(identity, "test-agent")?.canManage({
        id: "post",
        type: "post",
        createdById: "learner",
        fields: { title: "Draft", slug: "draft", state: "draft", postType: "lesson" },
      }),
    ).toBe(false);
  });
  it.each([
    ["revoked", { ...valid, revokedAt: new Date() }],
    ["expired", { ...valid, expiresAt: new Date(now - 1) }],
  ] as const)(
    "getUserAbilityForRequest refuses %s tokens (sec-20261121-010)",
    async (_label, row) => {
      lookup.mockResolvedValue(row);
      const result = await getUserAbilityForRequest(
        new NextRequest("http://localhost/api/posts", {
          headers: { Authorization: "Bearer synthetic-token" },
        }),
      );
      expect(result.user).toBeNull();
      expect(result.ability.can("create", "Content")).toBe(false);
    },
  );
  it("getUserAbilityForRequest accepts a valid editor device token", async () => {
    lookup.mockResolvedValue(valid);
    expect(
      (
        await getUserAbilityForRequest(
          new NextRequest("http://localhost/api/posts", {
            headers: { Authorization: "Bearer synthetic-token" },
          }),
        )
      ).user?.id,
    ).toBe("author");
  });
});
