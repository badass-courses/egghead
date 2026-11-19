/**
 * GitHub account-linking contract.
 *
 * Drives the real Auth.js request handler (CSRF, sign-in redirect, PKCE
 * cookie, OAuth callback, database session) with the shipped egghead GitHub
 * provider and auth callbacks. GitHub itself is replaced by a fake `fetch`,
 * and the database by an in-memory Auth.js adapter that keeps the
 * `(provider, providerAccountId)` uniqueness the MySQL Account table enforces.
 * Every identity here is a throwaway fixture; no real GitHub account is used.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Auth } from "@auth/core";
import type {
  Adapter,
  AdapterAccount,
  AdapterSession,
  AdapterUser,
  VerificationToken,
} from "@auth/core/adapters";
import GithubProvider, { type GitHubEmail } from "@auth/core/providers/github";
import PostmarkProvider from "@auth/core/providers/postmark";

import { createAuthConfig } from "../../src/coursebuilder/auth-config-factory";
import {
  createGithubProvider,
  selectVerifiedGithubEmail,
} from "../../src/coursebuilder/github-provider";

const BASE_URL = "http://localhost:3008";
const SECRET = "auth-linking-contract-secret-not-a-real-secret";

type FakeGithubIdentity = {
  id: number;
  login: string;
  email: string | null;
  emails: GitHubEmail[];
};

type MemoryStore = {
  adapter: Adapter;
  users: Map<string, AdapterUser>;
  accounts: AdapterAccount[];
  seedUser: (email: string) => AdapterUser;
  seedGithubAccount: (userId: string, githubId: number) => void;
};

function createMemoryStore(): MemoryStore {
  const users = new Map<string, AdapterUser>();
  const accounts: AdapterAccount[] = [];
  const sessions = new Map<string, AdapterSession>();
  const verificationTokens: VerificationToken[] = [];
  let nextUserId = 1;

  function insertUser(user: Omit<AdapterUser, "id">) {
    const created: AdapterUser = { ...user, id: `user_${nextUserId}` };
    nextUserId += 1;
    users.set(created.id, created);
    return created;
  }

  function insertAccount(account: AdapterAccount) {
    const duplicate = accounts.some(
      (existing) =>
        existing.provider === account.provider &&
        existing.providerAccountId === account.providerAccountId,
    );
    if (duplicate) throw new Error("Duplicate (provider, providerAccountId)");
    accounts.push(account);
  }

  const adapter: Adapter = {
    async createUser(user) {
      return insertUser({
        email: user.email,
        emailVerified: user.emailVerified,
        name: user.name ?? null,
      });
    },
    async getUser(id) {
      return users.get(id) ?? null;
    },
    async getUserByEmail(email) {
      const normalized = email.toLowerCase();
      return [...users.values()].find((user) => user.email.toLowerCase() === normalized) ?? null;
    },
    async getUserByAccount({ provider, providerAccountId }) {
      const account = accounts.find(
        (candidate) =>
          candidate.provider === provider && candidate.providerAccountId === providerAccountId,
      );
      return account ? (users.get(account.userId) ?? null) : null;
    },
    async updateUser(user) {
      const existing = users.get(user.id);
      if (!existing) throw new Error("Unknown user");
      const updated = { ...existing, ...user };
      users.set(updated.id, updated);
      return updated;
    },
    async linkAccount(account) {
      insertAccount(account);
      return account;
    },
    async createSession(session) {
      sessions.set(session.sessionToken, session);
      return session;
    },
    async getSessionAndUser(sessionToken) {
      const session = sessions.get(sessionToken);
      const user = session ? users.get(session.userId) : undefined;
      return session && user ? { session, user } : null;
    },
    async updateSession(session) {
      const existing = sessions.get(session.sessionToken);
      if (!existing) return null;
      const updated = { ...existing, ...session };
      sessions.set(updated.sessionToken, updated);
      return updated;
    },
    async deleteSession(sessionToken) {
      sessions.delete(sessionToken);
    },
    async createVerificationToken(token) {
      verificationTokens.push(token);
      return token;
    },
    async useVerificationToken({ identifier, token }) {
      const index = verificationTokens.findIndex(
        (candidate) => candidate.identifier === identifier && candidate.token === token,
      );
      if (index === -1) return null;
      const [used] = verificationTokens.splice(index, 1);
      return used ?? null;
    },
  };

  return {
    adapter,
    users,
    accounts,
    seedUser: (email) => insertUser({ email, emailVerified: new Date(), name: null }),
    seedGithubAccount: (userId, githubId) =>
      insertAccount({
        userId,
        type: "oauth",
        provider: "github",
        providerAccountId: String(githubId),
      }),
  };
}

class CookieJar {
  private readonly cookies = new Map<string, string>();

  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  absorb(response: Response) {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = cookie.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      const expired = attributes.some((attribute) => {
        const [key = "", rawValue = ""] = attribute.split("=");
        const normalizedKey = key.trim().toLowerCase();
        if (normalizedKey === "max-age") return Number(rawValue) <= 0;
        if (normalizedKey === "expires") return Date.parse(rawValue) <= Date.now();
        return false;
      });
      if (expired || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

type TestAuthConfig = ReturnType<typeof createAuthConfig> & {
  basePath: string;
  logger: { error: (error: Error) => void };
};

/** Refusals are expected here; keep Auth.js from printing them as failures. */
const authErrors: string[] = [];
const quietLogger = { error: (error: Error) => void authErrors.push(error.name) };

function fixedConfig(store: MemoryStore, sentLinks: string[]): TestAuthConfig {
  return {
    ...createAuthConfig({
      adapter: store.adapter,
      providers: [
        createGithubProvider({ clientId: "test-client", clientSecret: "test-client-secret" }),
        PostmarkProvider({
          apiKey: "test-postmark-key",
          from: "egghead test <no-reply@egghead.local>",
          sendVerificationRequest: async ({ url }) => {
            sentLinks.push(url);
          },
        }),
      ],
      secret: SECRET,
    }),
    basePath: "/api/auth",
    logger: quietLogger,
  };
}

/** The exact GitHub provider config shipped before this fix. */
function preFixConfig(store: MemoryStore): TestAuthConfig {
  return {
    ...createAuthConfig({
      adapter: store.adapter,
      providers: [
        GithubProvider({
          clientId: "test-client",
          clientSecret: "test-client-secret",
          allowDangerousEmailAccountLinking: true,
        }),
      ],
      secret: SECRET,
    }),
    basePath: "/api/auth",
    logger: quietLogger,
  };
}

const realFetch = globalThis.fetch;
let githubIdentity: FakeGithubIdentity | null = null;

beforeEach(() => {
  githubIdentity = null;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "gho_test_token", token_type: "bearer", scope: "" });
    }
    if (!githubIdentity) return realFetch(input, init);
    if (url === "https://api.github.com/user") {
      return Response.json({
        id: githubIdentity.id,
        login: githubIdentity.login,
        name: null,
        email: githubIdentity.email,
        avatar_url: "https://avatars.example.test/u.png",
      });
    }
    if (url === "https://api.github.com/user/emails") return Response.json(githubIdentity.emails);
    throw new Error(`Unexpected fetch in auth contract: ${url}`);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function authRequest(
  config: TestAuthConfig,
  jar: CookieJar,
  path: string,
  init: { method?: string; body?: URLSearchParams } = {},
) {
  const headers = new Headers({ cookie: jar.header() });
  if (init.body) headers.set("content-type", "application/x-www-form-urlencoded");
  const response = await Auth(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body ? { body: init.body } : {}),
    }),
    config,
  );
  jar.absorb(response);
  return response;
}

async function csrfToken(config: TestAuthConfig, jar: CookieJar) {
  const body: unknown = await (await authRequest(config, jar, "/csrf")).json();
  if (typeof body !== "object" || body === null || !("csrfToken" in body)) {
    throw new Error("Missing CSRF token");
  }
  return String(body.csrfToken);
}

async function signInWithGithub(
  config: TestAuthConfig,
  jar: CookieJar,
  identity: FakeGithubIdentity,
) {
  const token = await csrfToken(config, jar);
  const start = await authRequest(config, jar, "/signin/github", {
    method: "POST",
    body: new URLSearchParams({ csrfToken: token, callbackUrl: `${BASE_URL}/profile` }),
  });
  const authorizeUrl = new URL(start.headers.get("location") ?? "");
  assert.equal(authorizeUrl.origin, "https://github.com");

  githubIdentity = identity;
  const callbackParams = new URLSearchParams({ code: "fake-github-code" });
  const state = authorizeUrl.searchParams.get("state");
  if (state) callbackParams.set("state", state);
  const callback = await authRequest(config, jar, `/callback/github?${callbackParams}`);
  githubIdentity = null;

  return new URL(callback.headers.get("location") ?? "", BASE_URL);
}

async function signInWithMagicLink(
  config: TestAuthConfig,
  jar: CookieJar,
  email: string,
  sentLinks: string[],
) {
  const token = await csrfToken(config, jar);
  await authRequest(config, jar, "/signin/postmark", {
    method: "POST",
    body: new URLSearchParams({ csrfToken: token, email, callbackUrl: `${BASE_URL}/profile` }),
  });
  const link = sentLinks.at(-1);
  if (!link) throw new Error("No magic link was sent");
  const linkUrl = new URL(link);
  return authRequest(config, jar, linkUrl.pathname.replace("/api/auth", "") + linkUrl.search);
}

async function sessionUserId(config: TestAuthConfig, jar: CookieJar) {
  const body: unknown = await (await authRequest(config, jar, "/session")).json();
  if (typeof body !== "object" || body === null || !("user" in body)) return null;
  const { user } = body;
  if (typeof user !== "object" || user === null || !("id" in user)) return null;
  return String(user.id);
}

function githubAccountOwner(store: MemoryStore, githubId: number) {
  return (
    store.accounts.find(
      (account) => account.provider === "github" && account.providerAccountId === String(githubId),
    )?.userId ?? null
  );
}

const VICTIM_EMAIL = "victim@example.test";

/** Attacker's GitHub account: holds the victim's address, never verified it. */
const attackerUnverified: FakeGithubIdentity = {
  id: 90_001,
  login: "throwaway-attacker",
  email: null,
  emails: [{ email: VICTIM_EMAIL, primary: true, verified: false, visibility: "private" }],
};

/** Same attack where GitHub reports the address verified (stale or recycled address). */
const attackerVerified: FakeGithubIdentity = {
  ...attackerUnverified,
  emails: [{ email: VICTIM_EMAIL, primary: true, verified: true, visibility: "private" }],
};

void test("before: the pre-fix GitHub config hands a matching-email user to a stranger", async () => {
  const store = createMemoryStore();
  const victim = store.seedUser(VICTIM_EMAIL);
  const config = preFixConfig(store);
  const attacker = new CookieJar();

  const landed = await signInWithGithub(config, attacker, attackerUnverified);

  assert.equal(landed.pathname, "/profile");
  assert.equal(await sessionUserId(config, attacker), victim.id);
  assert.equal(githubAccountOwner(store, attackerUnverified.id), victim.id);
});

void test("after: an unverified GitHub email is refused and nothing is linked", async () => {
  const store = createMemoryStore();
  store.seedUser(VICTIM_EMAIL);
  const config = fixedConfig(store, []);
  const attacker = new CookieJar();

  const landed = await signInWithGithub(config, attacker, attackerUnverified);

  assert.equal(landed.pathname, "/login");
  assert.ok(landed.searchParams.get("error"));
  assert.equal(await sessionUserId(config, attacker), null);
  assert.equal(store.accounts.length, 0);
  assert.equal(store.users.size, 1);
});

void test("after: a verified matching email still cannot take over an unlinked user", async () => {
  const store = createMemoryStore();
  store.seedUser(VICTIM_EMAIL);
  const config = fixedConfig(store, []);
  const attacker = new CookieJar();

  const landed = await signInWithGithub(config, attacker, attackerVerified);

  assert.equal(landed.pathname, "/login");
  assert.equal(landed.searchParams.get("error"), "OAuthAccountNotLinked");
  assert.equal(await sessionUserId(config, attacker), null);
  assert.equal(store.accounts.length, 0);
});

void test("after: a migrated GitHub user signs in by GitHub user id, not by email", async () => {
  const store = createMemoryStore();
  const migrated = store.seedUser("old-address@example.test");
  store.seedGithubAccount(migrated.id, 4_242);
  const config = fixedConfig(store, []);
  const jar = new CookieJar();

  const landed = await signInWithGithub(config, jar, {
    id: 4_242,
    login: "migrated-user",
    email: "new-address@example.test",
    emails: [
      { email: "new-address@example.test", primary: true, verified: true, visibility: "public" },
    ],
  });

  assert.equal(landed.pathname, "/profile");
  assert.equal(await sessionUserId(config, jar), migrated.id);
  assert.equal(store.users.size, 1);
});

void test("after: a new GitHub user gets a new account", async () => {
  const store = createMemoryStore();
  const existing = store.seedUser(VICTIM_EMAIL);
  const config = fixedConfig(store, []);
  const jar = new CookieJar();

  const landed = await signInWithGithub(config, jar, {
    id: 7_007,
    login: "brand-new",
    email: null,
    emails: [
      { email: "stale@example.test", primary: false, verified: false, visibility: "private" },
      { email: "brand-new@example.test", primary: true, verified: true, visibility: "private" },
    ],
  });

  const userId = await sessionUserId(config, jar);
  assert.equal(landed.pathname, "/profile");
  assert.ok(userId);
  assert.notEqual(userId, existing.id);
  assert.equal(store.users.get(userId)?.email, "brand-new@example.test");
  assert.equal(githubAccountOwner(store, 7_007), userId);
});

void test("after: magic link sign-in still works for an existing user", async () => {
  const store = createMemoryStore();
  const existing = store.seedUser(VICTIM_EMAIL);
  const sentLinks: string[] = [];
  const config = fixedConfig(store, sentLinks);
  const jar = new CookieJar();

  const callback = await signInWithMagicLink(config, jar, VICTIM_EMAIL, sentLinks);

  assert.equal(new URL(callback.headers.get("location") ?? "", BASE_URL).pathname, "/profile");
  assert.equal(await sessionUserId(config, jar), existing.id);
});

void test("after: an unlinked migrated user recovers by magic link, then connects GitHub", async () => {
  const store = createMemoryStore();
  const migrated = store.seedUser(VICTIM_EMAIL);
  const sentLinks: string[] = [];
  const config = fixedConfig(store, sentLinks);
  const owner = { ...attackerVerified, id: 5_150, login: "real-owner" };

  const refused = await signInWithGithub(config, new CookieJar(), owner);
  assert.equal(refused.searchParams.get("error"), "OAuthAccountNotLinked");

  const signedIn = new CookieJar();
  await signInWithMagicLink(config, signedIn, VICTIM_EMAIL, sentLinks);
  const connected = await signInWithGithub(config, signedIn, owner);
  assert.equal(connected.pathname, "/profile");
  assert.equal(githubAccountOwner(store, owner.id), migrated.id);

  const later = new CookieJar();
  await signInWithGithub(config, later, owner);
  assert.equal(await sessionUserId(config, later), migrated.id);
});

void test("after: a GitHub id already owned by one user cannot be connected to another", async () => {
  const store = createMemoryStore();
  const firstOwner = store.seedUser("first-owner@example.test");
  const secondUser = store.seedUser("second-user@example.test");
  store.seedGithubAccount(firstOwner.id, 3_333);
  const sentLinks: string[] = [];
  const config = fixedConfig(store, sentLinks);
  const jar = new CookieJar();

  await signInWithMagicLink(config, jar, "second-user@example.test", sentLinks);
  const landed = await signInWithGithub(config, jar, {
    id: 3_333,
    login: "shared-uid",
    email: "second-user@example.test",
    emails: [
      { email: "second-user@example.test", primary: true, verified: true, visibility: "public" },
    ],
  });

  assert.equal(landed.searchParams.get("error"), "OAuthAccountNotLinked");
  assert.equal(githubAccountOwner(store, 3_333), firstOwner.id);
  assert.equal(await sessionUserId(config, jar), secondUser.id);
});

void test("selectVerifiedGithubEmail only returns verified addresses", () => {
  const emails: GitHubEmail[] = [
    {
      email: "primary-unverified@example.test",
      primary: true,
      verified: false,
      visibility: "private",
    },
    { email: "Public@Example.test", primary: false, verified: true, visibility: "public" },
  ];

  assert.equal(selectVerifiedGithubEmail("public@example.test", emails), "Public@Example.test");
  assert.equal(selectVerifiedGithubEmail(null, emails), null);
  assert.equal(selectVerifiedGithubEmail("primary-unverified@example.test", emails), null);
  assert.equal(
    selectVerifiedGithubEmail(null, [
      { email: "ok@example.test", primary: true, verified: true, visibility: "private" },
    ]),
    "ok@example.test",
  );
});
