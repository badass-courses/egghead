/**
 * GitHub account-linking contract.
 *
 * Drives the real Auth.js request handler (CSRF, sign-in redirect, PKCE
 * cookie, OAuth callback, database session) with the shipped egghead GitHub
 * provider and auth callbacks. GitHub itself is replaced by a fake `fetch`.
 *
 * Store: in-memory by default. With `AUTH_LINKING_MYSQL_URL` set to a
 * disposable local MySQL (loopback host, database ending `_test`, schema
 * pushed from `apps/web/drizzle.config.ts`), every scenario runs against the
 * shipped `createAuthJsAdapter(getCourseBuilderAdapter())` instead.
 *
 * Every identity here is a throwaway fixture; no real GitHub account is used.
 */
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { Auth } from "@auth/core";
import GithubProvider, { type GitHubEmail } from "@auth/core/providers/github";
import PostmarkProvider from "@auth/core/providers/postmark";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LoginErrorAlert } from "../../src/app/login/login-error";
import { createAuthConfig } from "../../src/coursebuilder/auth-config-factory";
import {
  createGithubProvider,
  GITHUB_EMAIL_UNVERIFIED_ERROR,
  GITHUB_OAUTH_SCOPE,
  selectVerifiedGithubEmail,
} from "../../src/coursebuilder/github-provider";
import { createMemoryAuthStore, type AuthStore } from "./auth-store";
import { createMysqlAuthStore } from "./mysql-auth-store";

const BASE_URL = "http://localhost:3008";
const SECRET = "auth-linking-contract-secret-not-a-real-secret";

const mysqlUrl = process.env["AUTH_LINKING_MYSQL_URL"];
const store: AuthStore = mysqlUrl ? await createMysqlAuthStore(mysqlUrl) : createMemoryAuthStore();

type FakeGithubIdentity = {
  id: number;
  login: string;
  email: string | null;
  emails: GitHubEmail[];
  emailsStatus?: number;
};

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

/** Refusals are expected here; collect them instead of printing them as failures. */
const authErrors: string[] = [];
const quietLogger = { error: (error: Error) => void authErrors.push(error.name) };

function eggheadConfig(sentLinks: string[] = []): TestAuthConfig {
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

/** Stock Auth.js GitHub provider with email linking, no verified-email check. */
function stockProviderConfig(): TestAuthConfig {
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

beforeEach(async () => {
  await store.reset();
  authErrors.length = 0;
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
    if (url === "https://api.github.com/user/emails") {
      const status = githubIdentity.emailsStatus ?? 200;
      return status === 200
        ? Response.json(githubIdentity.emails)
        : Response.json({ message: "Resource not accessible by integration" }, { status });
    }
    throw new Error(`Unexpected fetch in auth contract: ${url}`);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

after(async () => {
  await store.reset();
  await store.close();
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

  return {
    authorizeUrl,
    landed: new URL(callback.headers.get("location") ?? "", BASE_URL),
  };
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

const githubOwner = (githubId: number) => store.accountOwner("github", String(githubId));

const EXISTING_EMAIL = "existing@example.test";

/** A GitHub account holding the existing user's address, never verified at GitHub. */
const unverifiedHolder: FakeGithubIdentity = {
  id: 90_001,
  login: "throwaway-unverified",
  email: null,
  emails: [{ email: EXISTING_EMAIL, primary: true, verified: false, visibility: "private" }],
};

/** The same person's GitHub account with the address verified at GitHub. */
const verifiedOwner: FakeGithubIdentity = {
  ...unverifiedHolder,
  login: "throwaway-verified",
  emails: [{ email: EXISTING_EMAIL, primary: true, verified: true, visibility: "private" }],
};

const name = (scenario: string) => `[${store.name}] ${scenario}`;

void test(
  name("stock Auth.js GitHub provider links an unverified address (why the check exists)"),
  async () => {
    const existing = await store.seedUser(EXISTING_EMAIL);
    const config = stockProviderConfig();
    const jar = new CookieJar();

    const { landed } = await signInWithGithub(config, jar, unverifiedHolder);

    assert.equal(landed.pathname, "/profile");
    assert.equal(await sessionUserId(config, jar), existing);
    assert.equal(await githubOwner(unverifiedHolder.id), existing);
  },
);

void test(name("the GitHub provider requests the read:user user:email scope"), async () => {
  const { authorizeUrl } = await signInWithGithub(eggheadConfig(), new CookieJar(), verifiedOwner);

  assert.equal(GITHUB_OAUTH_SCOPE, "read:user user:email");
  assert.equal(authorizeUrl.searchParams.get("scope"), GITHUB_OAUTH_SCOPE);
});

void test(name("a verified matching GitHub email links to the existing user"), async () => {
  const existing = await store.seedUser(EXISTING_EMAIL);
  const config = eggheadConfig();
  const jar = new CookieJar();

  const { landed } = await signInWithGithub(config, jar, verifiedOwner);

  assert.equal(landed.pathname, "/profile");
  assert.equal(await sessionUserId(config, jar), existing);
  assert.equal(await githubOwner(verifiedOwner.id), existing);
  assert.equal(await store.userCount(), 1);

  const later = new CookieJar();
  await signInWithGithub(config, later, verifiedOwner);
  assert.equal(await sessionUserId(config, later), existing);
});

void test(name("a GitHub email differing only in case links to the same user"), async () => {
  const mixedCase = await store.seedUser("Mixed.Case@Example.test");
  const lowerCase = await store.seedUser("lower@example.test");
  const config = eggheadConfig();

  const first = new CookieJar();
  await signInWithGithub(config, first, {
    id: 61_001,
    login: "case-one",
    email: null,
    emails: [
      { email: "mixed.case@example.test", primary: true, verified: true, visibility: "private" },
    ],
  });
  const second = new CookieJar();
  await signInWithGithub(config, second, {
    id: 61_002,
    login: "case-two",
    email: " LOWER@Example.TEST ",
    emails: [{ email: "LOWER@Example.TEST", primary: true, verified: true, visibility: "public" }],
  });

  assert.equal(await sessionUserId(config, first), mixedCase);
  assert.equal(await sessionUserId(config, second), lowerCase);
  assert.equal(await store.userCount(), 2);
});

void test(
  name("an unverified GitHub email does not link and gets the verify-email message"),
  async () => {
    await store.seedUser(EXISTING_EMAIL);
    const config = eggheadConfig();
    const jar = new CookieJar();

    const { landed } = await signInWithGithub(config, jar, unverifiedHolder);

    assert.equal(landed.pathname, "/login");
    assert.equal(landed.searchParams.get("error"), GITHUB_EMAIL_UNVERIFIED_ERROR);
    assert.equal(await sessionUserId(config, jar), null);
    assert.equal(await store.accountCount(), 0);
    assert.equal(await store.userCount(), 1);
  },
);

void test(name("a GitHub account with no email gets the verify-email message"), async () => {
  const config = eggheadConfig();
  const jar = new CookieJar();

  const { landed } = await signInWithGithub(config, jar, {
    id: 90_002,
    login: "no-email",
    email: null,
    emails: [],
  });

  assert.equal(landed.searchParams.get("error"), GITHUB_EMAIL_UNVERIFIED_ERROR);
  assert.equal(await sessionUserId(config, jar), null);
  assert.equal(await store.accountCount(), 0);
  assert.equal(await store.userCount(), 0);
});

void test(name("a failed /user/emails call reads as no verified email, not an error"), async () => {
  await store.seedUser(EXISTING_EMAIL);
  const config = eggheadConfig();
  const jar = new CookieJar();

  const { landed } = await signInWithGithub(config, jar, { ...verifiedOwner, emailsStatus: 403 });

  assert.equal(landed.searchParams.get("error"), GITHUB_EMAIL_UNVERIFIED_ERROR);
  assert.deepEqual(authErrors, []);
  assert.equal(await store.accountCount(), 0);
});

void test(
  name("a linked GitHub id still signs in when GitHub reports no verified email"),
  async () => {
    const migrated = await store.seedUser("old-address@example.test");
    await store.seedAccount(migrated, "github", "4243");
    const config = eggheadConfig();
    const jar = new CookieJar();

    const { landed } = await signInWithGithub(config, jar, {
      id: 4_243,
      login: "linked-no-email",
      email: null,
      emails: [],
    });

    assert.equal(landed.pathname, "/profile");
    assert.equal(await sessionUserId(config, jar), migrated);
  },
);

void test(name("the verify-email message renders on /login"), () => {
  const html = renderToStaticMarkup(
    createElement(LoginErrorAlert, { error: GITHUB_EMAIL_UNVERIFIED_ERROR }),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Verify your email on GitHub/);
  assert.match(html, /sign in with an email link/);
  assert.equal(renderToStaticMarkup(createElement(LoginErrorAlert, { error: undefined })), "");
});

void test(name("a migrated GitHub user signs in by GitHub user id, not by email"), async () => {
  const migrated = await store.seedUser("old-address@example.test");
  await store.seedAccount(migrated, "github", "4242");
  const config = eggheadConfig();
  const jar = new CookieJar();

  const { landed } = await signInWithGithub(config, jar, {
    id: 4_242,
    login: "migrated-user",
    email: "new-address@example.test",
    emails: [
      { email: "new-address@example.test", primary: true, verified: true, visibility: "public" },
    ],
  });

  assert.equal(landed.pathname, "/profile");
  assert.equal(await sessionUserId(config, jar), migrated);
  assert.equal(await store.userCount(), 1);
});

void test(name("a new GitHub user gets a new account"), async () => {
  const existing = await store.seedUser(EXISTING_EMAIL);
  const config = eggheadConfig();
  const jar = new CookieJar();

  const { landed } = await signInWithGithub(config, jar, {
    id: 7_007,
    login: "brand-new",
    email: null,
    emails: [
      { email: "stale@example.test", primary: false, verified: false, visibility: "private" },
      { email: "Brand-New@Example.test", primary: true, verified: true, visibility: "private" },
    ],
  });

  const userId = await sessionUserId(config, jar);
  assert.equal(landed.pathname, "/profile");
  assert.ok(userId);
  assert.notEqual(userId, existing);
  assert.equal(await store.userEmail(userId), "brand-new@example.test");
  assert.equal(await githubOwner(7_007), userId);
});

void test(name("magic link sign-in still works for an existing user"), async () => {
  const existing = await store.seedUser(EXISTING_EMAIL);
  const sentLinks: string[] = [];
  const config = eggheadConfig(sentLinks);
  const jar = new CookieJar();

  const callback = await signInWithMagicLink(config, jar, EXISTING_EMAIL, sentLinks);

  assert.equal(new URL(callback.headers.get("location") ?? "", BASE_URL).pathname, "/profile");
  assert.equal(await sessionUserId(config, jar), existing);
});

void test(
  name("a GitHub id already owned by one user cannot be connected to another"),
  async () => {
    const firstOwner = await store.seedUser("first-owner@example.test");
    const secondUser = await store.seedUser("second-user@example.test");
    await store.seedAccount(firstOwner, "github", "3333");
    const sentLinks: string[] = [];
    const config = eggheadConfig(sentLinks);
    const jar = new CookieJar();

    await signInWithMagicLink(config, jar, "second-user@example.test", sentLinks);
    const { landed } = await signInWithGithub(config, jar, {
      id: 3_333,
      login: "shared-uid",
      email: "second-user@example.test",
      emails: [
        { email: "second-user@example.test", primary: true, verified: true, visibility: "public" },
      ],
    });

    assert.equal(landed.searchParams.get("error"), "OAuthAccountNotLinked");
    assert.equal(await githubOwner(3_333), firstOwner);
    assert.equal(await sessionUserId(config, jar), secondUser);
  },
);

void test(name("the Account table refuses a second owner for one GitHub id"), async () => {
  const firstOwner = await store.seedUser("first-owner@example.test");
  const secondUser = await store.seedUser("second-user@example.test");
  const link = async (userId: string) => {
    if (!store.adapter.linkAccount) throw new Error("Adapter cannot link accounts");
    await store.adapter.linkAccount({
      userId,
      type: "oauth",
      provider: "github",
      providerAccountId: "8888",
    });
  };

  await link(firstOwner);
  await assert.rejects(() => link(secondUser), /Duplicate entry/);
  assert.equal(await githubOwner(8_888), firstOwner);
  assert.equal(await store.accountCount(), 1);
});

void test("selectVerifiedGithubEmail only returns verified addresses, trimmed and lowercased", () => {
  const emails: GitHubEmail[] = [
    {
      email: "primary-unverified@example.test",
      primary: true,
      verified: false,
      visibility: "private",
    },
    { email: " Public@Example.test ", primary: false, verified: true, visibility: "public" },
  ];

  assert.equal(selectVerifiedGithubEmail("public@example.test", emails), "public@example.test");
  assert.equal(selectVerifiedGithubEmail(null, emails), null);
  assert.equal(selectVerifiedGithubEmail("primary-unverified@example.test", emails), null);
  assert.equal(
    selectVerifiedGithubEmail(null, [
      { email: "OK@Example.test", primary: true, verified: true, visibility: "private" },
    ]),
    "ok@example.test",
  );
});
