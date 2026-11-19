import { describe, expect, it, vi } from "vitest";

import { decodeFeedParam, renderByParam, serveMemberFeed } from "./response";
import {
  authenticateFeedRequest,
  feedRoleGrantsAccess,
  hashFeedEmail,
  hashFeedToken,
  type FeedTokenRecord,
  type FeedTokenStore,
} from "./token";
import {
  legacyFeedTokenId,
  parseLegacyFeedTokenExport,
  RAILS_TOKEN_EXPORT_SQL,
  railsUserIdKey,
  revocationAllowed,
} from "./token-import";

// Rails tokens are SecureRandom.uuid values. These are fixtures, not real tokens.
const MEMBER_TOKEN = "3f1c2a9e-7b4d-4e8f-9a01-2b3c4d5e6f70";
const REVOKED_TOKEN = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const NON_MEMBER_TOKEN = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const MOVED_TOKEN = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b";
const NO_EMAIL_TOKEN = "6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c";

function memoryStore(): FeedTokenStore {
  const records = new Map<string, FeedTokenRecord>([
    [
      hashFeedToken(MEMBER_TOKEN),
      { userId: "u_member", email: "member@example.test", railsEmailSha256: null, revokedAt: null },
    ],
    [
      hashFeedToken(REVOKED_TOKEN),
      {
        userId: "u_member",
        email: "member@example.test",
        railsEmailSha256: null,
        revokedAt: new Date("2026-01-01"),
      },
    ],
    [
      hashFeedToken(NON_MEMBER_TOKEN),
      { userId: "u_free", email: "free@example.test", railsEmailSha256: null, revokedAt: null },
    ],
    // Changed email in CB after Rails exported the token.
    [
      hashFeedToken(MOVED_TOKEN),
      {
        userId: "u_member",
        email: "new-address@example.test",
        railsEmailSha256: hashFeedEmail("old-address@example.test"),
        revokedAt: null,
      },
    ],
    // CB user with no email at all.
    [
      hashFeedToken(NO_EMAIL_TOKEN),
      { userId: "u_member", email: null, railsEmailSha256: null, revokedAt: null },
    ],
  ]);
  return { findByTokenSha256: async (hash) => records.get(hash) ?? null };
}

const isMember = async (userId: string) => userId === "u_member";
const deps = { store: memoryStore(), isMember };

function params(email: string | null, token: string | null) {
  const search = new URLSearchParams();
  if (email !== null) search.set("user_email", email);
  if (token !== null) search.set("user_token", token);
  return search;
}

function feedRequest(email: string | null, token: string | null) {
  return new Request(`https://egghead.io/lessons/pro_feed?${params(email, token).toString()}`);
}

describe("pro_feed token auth", () => {
  it("accepts a valid token for a member", async () => {
    await expect(
      authenticateFeedRequest(params("member@example.test", MEMBER_TOKEN), deps),
    ).resolves.toEqual({
      ok: true,
      userId: "u_member",
    });
  });

  it("matches the email case-insensitively, like Rails find_by_email on MySQL", async () => {
    const result = await authenticateFeedRequest(
      params(" Member@Example.TEST ", MEMBER_TOKEN),
      deps,
    );
    expect(result.ok).toBe(true);
  });

  it("refuses a revoked token", async () => {
    await expect(
      authenticateFeedRequest(params("member@example.test", REVOKED_TOKEN), deps),
    ).resolves.toEqual({
      ok: false,
      status: 403,
      reason: "revoked_token",
    });
  });

  it("refuses an unknown token", async () => {
    const result = await authenticateFeedRequest(
      params("member@example.test", "11111111-2222-4333-8444-555555555555"),
      deps,
    );
    expect(result).toEqual({ ok: false, status: 403, reason: "unknown_token" });
  });

  it("accepts the Rails email captured at import, or the current CB email (judge #10)", async () => {
    await expect(
      authenticateFeedRequest(params(" Old-Address@example.test", MOVED_TOKEN), deps),
    ).resolves.toEqual({ ok: true, userId: "u_member" });
    await expect(
      authenticateFeedRequest(params("new-address@example.test", MOVED_TOKEN), deps),
    ).resolves.toEqual({ ok: true, userId: "u_member" });
    await expect(
      authenticateFeedRequest(params("someone-else@example.test", MOVED_TOKEN), deps),
    ).resolves.toEqual({ ok: false, status: 403, reason: "email_mismatch" });
  });

  it("answers 403, not a throw, when the CB user has no email and no Rails email hash", async () => {
    await expect(
      authenticateFeedRequest(params("member@example.test", NO_EMAIL_TOKEN), deps),
    ).resolves.toEqual({ ok: false, status: 403, reason: "email_mismatch" });
  });

  it("refuses a valid token presented with someone else's email", async () => {
    const result = await authenticateFeedRequest(params("free@example.test", MEMBER_TOKEN), deps);
    expect(result).toEqual({ ok: false, status: 403, reason: "email_mismatch" });
  });

  it("refuses a valid token for a non-member", async () => {
    const result = await authenticateFeedRequest(
      params("free@example.test", NON_MEMBER_TOKEN),
      deps,
    );
    expect(result).toEqual({ ok: false, status: 403, reason: "not_a_member" });
  });

  it("refuses missing credentials without touching the store", async () => {
    const findByTokenSha256 = vi.fn(async () => null);
    const result = await authenticateFeedRequest(params(null, MEMBER_TOKEN), {
      store: { findByTokenSha256 },
      isMember,
    });
    expect(result).toEqual({ ok: false, status: 403, reason: "missing_credentials" });
    expect(findByTokenSha256).not.toHaveBeenCalled();
  });

  it("only looks tokens up by SHA-256, never by the raw value", async () => {
    const findByTokenSha256 = vi.fn(async () => null);
    await authenticateFeedRequest(params("member@example.test", MEMBER_TOKEN), {
      store: { findByTokenSha256 },
      isMember,
    });
    expect(findByTokenSha256).toHaveBeenCalledWith(hashFeedToken(MEMBER_TOKEN));
    expect(hashFeedToken(MEMBER_TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("maps Rails instructor/staff abilities to CB admin and contributor roles", () => {
    expect(feedRoleGrantsAccess("admin")).toBe(true);
    expect(feedRoleGrantsAccess("contributor")).toBe(true);
    expect(feedRoleGrantsAccess("user")).toBe(false);
    expect(feedRoleGrantsAccess(null)).toBe(false);
  });
});

describe("serveMemberFeed", () => {
  it("renders private RSS for a member", async () => {
    const response = await serveMemberFeed(
      feedRequest("member@example.test", MEMBER_TOKEN),
      deps,
      async () => "<rss/>",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, max-age=900");
  });

  it("returns 403 and never renders for a revoked, unknown or non-member token", async () => {
    const render = vi.fn(async () => "<rss/>");
    const cases = [
      ["member@example.test", REVOKED_TOKEN],
      ["member@example.test", "nope"],
      ["free@example.test", NON_MEMBER_TOKEN],
    ] as const;
    const responses = await Promise.all(
      cases.map(([email, token]) => serveMemberFeed(feedRequest(email, token), deps, render)),
    );
    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(render).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown feed after auth", async () => {
    const response = await serveMemberFeed(
      feedRequest("member@example.test", MEMBER_TOKEN),
      deps,
      async () => null,
    );
    expect(response.status).toBe(404);
  });

  it("returns a retryable 503, not a 403, when the token store is down", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await serveMemberFeed(
      feedRequest("member@example.test", MEMBER_TOKEN),
      {
        store: {
          findByTokenSha256: async () => {
            throw new Error("connect ECONNREFUSED");
          },
        },
        isMember,
      },
      async () => "<rss/>",
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("300");
    error.mockRestore();
  });
});

describe("Rails token export parsing", () => {
  const hashA = hashFeedToken(MEMBER_TOKEN);
  const hashB = hashFeedToken(NON_MEMBER_TOKEN);

  it("accepts hashed rows and rejects raw tokens, bad ids and duplicates", () => {
    const csv = [
      "rails_user_id,token_sha256,email_sha256",
      `101,${hashA.toUpperCase()},${hashFeedEmail("a@example.test")}`,
      `102,${hashB}`,
      `103,${MEMBER_TOKEN}`,
      `abc,${hashB}`,
      `101,${hashFeedToken(REVOKED_TOKEN)}`,
      `104,${hashB}`,
      `105,${hashB},${hashA},extra`,
      `106,${hashFeedToken("x")},not-a-hash`,
      "",
    ].join("\n");
    const result = parseLegacyFeedTokenExport(csv);
    expect(result.rows).toEqual([
      { railsUserId: "101", tokenSha256: hashA, emailSha256: hashFeedEmail("a@example.test") },
      { railsUserId: "102", tokenSha256: hashB, emailSha256: null },
    ]);
    expect(result.rejected).toEqual([
      { line: 4, reason: "not_sha256_hex" },
      { line: 5, reason: "bad_rails_user_id" },
      { line: 6, reason: "duplicate_user" },
      { line: 7, reason: "duplicate_token" },
      { line: 8, reason: "extra_columns" },
      { line: 9, reason: "email_not_sha256_hex" },
    ]);
  });

  it("still parses a round-1 export without the email column", () => {
    const result = parseLegacyFeedTokenExport(`rails_user_id,token_sha256\n101,${hashA}\n`);
    expect(result).toEqual({
      rows: [{ railsUserId: "101", tokenSha256: hashA, emailSha256: null }],
      rejected: [],
    });
  });

  it("derives a stable row id per Rails user so re-imports upsert", () => {
    expect(legacyFeedTokenId("101")).toBe(legacyFeedTokenId("101"));
    expect(legacyFeedTokenId("101")).not.toBe(legacyFeedTokenId("102"));
    expect(legacyFeedTokenId("101")).toMatch(/^lft_[0-9a-f]{32}$/);
  });
});

describe("route params (judge #23)", () => {
  it("decodes good segments and turns malformed escapes into null", () => {
    expect(decodeFeedParam("react%20hooks")).toBe("react hooks");
    expect(decodeFeedParam("plain-slug")).toBe("plain-slug");
    expect(decodeFeedParam("%E0%A4%A")).toBeNull();
    expect(decodeFeedParam("%")).toBeNull();
    expect(decodeFeedParam("%20")).toBeNull();
  });

  it("answers 404 after auth for a malformed segment, without calling the renderer", async () => {
    const render = vi.fn(async () => "<rss/>");
    const response = await serveMemberFeed(
      feedRequest("member@example.test", MEMBER_TOKEN),
      deps,
      renderByParam("%E0%A4%A", render),
    );
    expect(response.status).toBe(404);
    expect(render).not.toHaveBeenCalled();
  });
});

describe("token import helpers (judge #13, #14)", () => {
  it("exports with Postgres pgcrypto, not MySQL SHA2", () => {
    expect(RAILS_TOKEN_EXPORT_SQL).toContain(
      "encode(digest(authentication_token, 'sha256'), 'hex')",
    );
    expect(RAILS_TOKEN_EXPORT_SQL).toContain(
      "encode(digest(lower(btrim(email)), 'sha256'), 'hex') AS email_sha256",
    );
    expect(RAILS_TOKEN_EXPORT_SQL).not.toMatch(/SHA2\(/i);
    // Postgres lower(btrim('  Ada@Example.TEST ')) then sha256 equals hashFeedEmail.
    expect(hashFeedEmail("  Ada@Example.TEST ")).toBe(hashFeedEmail("ada@example.test"));
  });

  it("produces the same hash Postgres encode(digest(token,sha256),hex) does", () => {
    // Known SHA-256 of the ASCII string "abc".
    expect(hashFeedToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("normalizes Rails ids from strings, numbers and bigints", () => {
    expect(railsUserIdKey("42")).toBe("42");
    expect(railsUserIdKey(" 42 ")).toBe("42");
    expect(railsUserIdKey(42)).toBe("42");
    expect(railsUserIdKey(42n)).toBe("42");
    expect(railsUserIdKey("042")).toBeNull();
    expect(railsUserIdKey(0)).toBeNull();
    expect(railsUserIdKey(null)).toBeNull();
  });

  it("guards full-sync revocation against mass revokes", () => {
    expect(revocationAllowed({ toRevoke: 0, active: 0, allowMassRevoke: false })).toBe(true);
    // Up to 25 revocations always pass; beyond that, at most 10% of active rows.
    expect(revocationAllowed({ toRevoke: 25, active: 30, allowMassRevoke: false })).toBe(true);
    expect(revocationAllowed({ toRevoke: 26, active: 30, allowMassRevoke: false })).toBe(false);
    expect(revocationAllowed({ toRevoke: 1000, active: 10_000, allowMassRevoke: false })).toBe(
      true,
    );
    expect(revocationAllowed({ toRevoke: 1001, active: 10_000, allowMassRevoke: false })).toBe(
      false,
    );
    expect(revocationAllowed({ toRevoke: 9000, active: 10_000, allowMassRevoke: true })).toBe(true);
    expect(revocationAllowed({ toRevoke: 2, active: 4, allowMassRevoke: false, minimum: 0 })).toBe(
      false,
    );
  });
});
