import type { Adapter } from "@auth/core/adapters";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { register } from "./instrumentation";
import { getEggheadRuntime, isReadOnlyBeta } from "./runtime";

const mocks = vi.hoisted(() => ({
  authGet: vi.fn(() => Response.json({ session: null })),
  authPost: vi.fn(() => Response.json({ delegated: true })),
  builderGet: vi.fn(() => Response.json({ session: null })),
  builderPost: vi.fn(() => Response.json({ delegated: true })),
  inngestServe: vi.fn(() => Response.json({ delegated: true })),
  getSessionAndUser: vi.fn<NonNullable<Adapter["getSessionAndUser"]>>(async () => null),
  query: vi.fn(async () => [[]]),
  execute: vi.fn(async () => [[]]),
  createSession: vi.fn(),
  updateSession: vi.fn(),
  deleteSession: vi.fn(),
  updateProfile: vi.fn(),
  disconnectGithub: vi.fn(),
  completeLesson: vi.fn(),
  saveCourseReview: vi.fn(),
}));

vi.mock("mysql2/promise", () => {
  const connection = { query: mocks.query, execute: mocks.execute };
  return {
    default: {
      createConnection: async () => connection,
      createPool: () => ({ ...connection, getConnection: async () => connection }),
    },
  };
});
vi.mock("./server/auth", () => ({ GET: mocks.authGet, POST: mocks.authPost }));
vi.mock("./db/adapter", () => ({ getCourseBuilderAdapter: () => mocks }));
vi.mock("./coursebuilder/config", () => ({
  handlers: { GET: mocks.builderGet, POST: mocks.builderPost },
}));
vi.mock("./subscriptions/webhook", () => ({ handleSubscriptionDeletion: async () => null }));
vi.mock("./inngest/config", () => ({ inngestConfig: {} }));
vi.mock("inngest/next", () => ({
  serve: () => ({ GET: mocks.inngestServe, POST: mocks.inngestServe, PUT: mocks.inngestServe }),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock("./coursebuilder/current-user", () => ({ getCurrentUser: async () => ({ id: "user" }) }));
vi.mock("./profile/data", () => ({ updatePrivateProfileName: mocks.updateProfile }));
vi.mock("./profile/github-disconnect", () => ({
  disconnectPrivateGithubAccount: mocks.disconnectGithub,
}));
vi.mock("./content/lesson", () => ({ getLessonById: async () => ({ id: "lesson" }) }));
vi.mock("./progress/resource-progress", () => ({ completeResourceForUser: mocks.completeLesson }));
vi.mock("./progress/course-progress", () => ({ saveCourseReviewForUser: mocks.saveCourseReview }));

function req(path: string, method = "GET") {
  return new NextRequest(`https://beta.example.test${path}`, { method });
}

beforeEach(() => {
  for (const key of [
    "EGGHEAD_RUNTIME",
    "VERCEL",
    "VERCEL_ENV",
    "VERCEL_PROJECT_NAME",
    "VERCEL_PROJECT_PRODUCTION_URL",
  ]) {
    vi.stubEnv(key, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("deployed runtime at Next startup", () => {
  it.each([
    ["VERCEL", "1", undefined],
    ["VERCEL_ENV", "preview", ""],
    ["VERCEL_ENV", "production", "   "],
  ])("defaults to read-only beta on %s=%s without a runtime", (key, marker, runtime) => {
    vi.stubEnv(key, marker);
    vi.stubEnv("EGGHEAD_RUNTIME", runtime);
    expect(register).not.toThrow();
    expect(getEggheadRuntime()).toBe("beta");
    expect(isReadOnlyBeta()).toBe(true);
  });

  it("refuses explicit production on the beta Vercel project", () => {
    vi.stubEnv("VERCEL_PROJECT_NAME", "beta-egghead");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("EGGHEAD_RUNTIME", "production");
    expect(register).toThrow("The beta Vercel project cannot use production runtime");
  });

  it("honors Vercel local fixture settings without opening writes", async () => {
    vi.stubEnv("VERCEL_PROJECT_NAME", "beta-egghead");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("EGGHEAD_RUNTIME", "local");
    vi.stubEnv("DATABASE_URL", "mysql://root:fixture@127.0.0.1:3307/egghead_test");
    const db = await import("./db/local-docker");
    expect(register).not.toThrow();
    expect(getEggheadRuntime()).toBe("local");
    expect(isReadOnlyBeta()).toBe(true);
    expect(db.commerceWritesAreAllowed()).toBe(false);
    await expect(import("../drizzle.config")).rejects.toThrow(
      "Web schema tools require local Docker",
    );
  });

  it("also recognizes beta by the platform production hostname", () => {
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "beta.egghead.io");
    vi.stubEnv("EGGHEAD_RUNTIME", "production");
    expect(register).toThrow("The beta Vercel project cannot use production runtime");
    vi.stubEnv("EGGHEAD_RUNTIME", "beta");
    expect(register).not.toThrow();
    expect(getEggheadRuntime()).toBe("beta");
    expect(isReadOnlyBeta()).toBe(true);
  });

  it("keeps local defaults and permits explicit production on a different project", () => {
    expect(getEggheadRuntime()).toBe("local");
    expect(isReadOnlyBeta()).toBe(false);
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_PROJECT_NAME", "egghead-web");
    vi.stubEnv("EGGHEAD_RUNTIME", "production");
    expect(register).not.toThrow();
    expect(getEggheadRuntime()).toBe("production");
    expect(isReadOnlyBeta()).toBe(false);
  });

  it("throws on unknown runtime values instead of falling back", () => {
    vi.stubEnv("EGGHEAD_RUNTIME", "prodution");
    expect(register).toThrow("Unsupported EGGHEAD_RUNTIME");
    vi.stubEnv("VERCEL", "1");
    expect(register).toThrow("Unsupported EGGHEAD_RUNTIME");
  });
});

describe("beta read-only boundaries", () => {
  it("does not load the web schema config for either a beta runtime or a remote target", async () => {
    vi.stubEnv("EGGHEAD_RUNTIME", "beta");
    vi.stubEnv("EGGHEAD_BETA_DB_APPROVED", "true");
    vi.stubEnv("DATABASE_URL", "mysql://reader:fixture@aws.connect.psdb.cloud/egghead");
    await expect(import("../drizzle.config")).rejects.toThrow(
      "Web schema tools require local Docker",
    );
    vi.resetModules();
    vi.stubEnv("EGGHEAD_RUNTIME", "local");
    await expect(import("../drizzle.config")).rejects.toThrow("Refusing non-local MySQL URL");
    vi.resetModules();
    vi.stubEnv("DATABASE_URL", "mysql://root:fixture@127.0.0.1:3307/egghead_test");
    await expect(import("../drizzle.config")).resolves.toHaveProperty("default.dialect", "mysql");
  });

  it("lets beta read through the shared pool and blocks DDL and DML before mysql2", async () => {
    vi.stubEnv("EGGHEAD_RUNTIME", "beta");
    vi.stubEnv("EGGHEAD_BETA_DB_APPROVED", "true");
    vi.stubEnv("EGGHEAD_DB_READ_ONLY", undefined);
    vi.stubEnv("DATABASE_URL", "mysql://reader:fixture@aws.connect.psdb.cloud/egghead");
    const db = await import("./db/local-docker");
    const pool = db.getEggheadMysqlPool();
    await pool.query("SELECT 1");
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenCalledWith("SELECT 1");
    expect(() => pool.execute("UPDATE egghead_User SET name = 'fixture'")).toThrow(/non-read/);
    const checkedOut = await pool.getConnection();
    const direct = await db.createEggheadMysqlConnection();
    expect(() => checkedOut.execute("CREATE TABLE fixture (id INT)")).toThrow(/non-read/);
    expect(() => direct.execute("DELETE FROM egghead_User")).toThrow(/non-read/);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("skips ordinary ingress and Inngest transport but leaves CourseBuilder session reads", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const cb = await import("./app/api/coursebuilder/[...nextCourseBuilder]/route");
    const inngest = await import("./app/api/inngest/route");
    expect(await (await cb.POST(req("/api/coursebuilder/webhook/stripe", "POST"))).json()).toEqual({
      received: true,
      skipped: "writes-blocked",
    });
    expect((await cb.POST(req("/api/coursebuilder/other", "POST"))).status).toBe(404);
    expect((await cb.GET(req("/api/coursebuilder/checkout/stripe"))).status).toBe(404);
    expect((await cb.GET(req("/api/coursebuilder/session"))).status).toBe(200);
    expect(mocks.builderGet).toHaveBeenCalledOnce();
    expect(mocks.builderPost).not.toHaveBeenCalled();
    expect((await inngest.GET(req("/api/inngest"), {})).status).toBe(404);
    expect((await inngest.PUT(req("/api/inngest", "PUT"), {})).status).toBe(404);
    expect((await inngest.POST(req("/api/inngest", "POST"), {})).status).toBe(404);
    expect(mocks.inngestServe).not.toHaveBeenCalled();
  });

  it("does not delegate Auth.js sign-in or OAuth callback requests", async () => {
    vi.stubEnv("EGGHEAD_RUNTIME", "beta");
    const auth = await import("./app/api/auth/[...nextauth]/route");
    expect((await auth.GET(req("/api/auth/callback/github?code=fixture"))).status).toBe(404);
    expect((await auth.POST(req("/api/auth/signin/postmark", "POST"))).status).toBe(404);
    expect((await auth.GET(req("/api/auth/session"))).status).toBe(200);
    expect(mocks.authGet).toHaveBeenCalledOnce();
    expect(mocks.authPost).not.toHaveBeenCalled();
  });

  it("disables GitHub and magic links with keys present without dropping session reads", async () => {
    vi.stubEnv("EGGHEAD_RUNTIME", "beta");
    vi.stubEnv("AUTH_SECRET", "fixture-secret");
    vi.stubEnv("SEND_EMAILS", "true");
    vi.stubEnv("POSTMARK_API_KEY", "fixture-postmark");
    vi.stubEnv("POSTMARK_FROM_EMAIL", "fixture@example.test");
    vi.stubEnv("GITHUB_CLIENT_ID", "fixture-github");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "fixture-github-secret");
    const { authConfig, isEmailAuthConfigured, isGithubAuthConfigured } =
      await import("./coursebuilder/auth-config");
    const { sendEmail } = await import("./coursebuilder/email-delivery");
    expect(isEmailAuthConfigured()).toBe(false);
    expect(isGithubAuthConfigured()).toBe(false);
    expect(authConfig.providers).toEqual([]);
    const known = {
      user: { id: "user", email: "fixture@example.test", emailVerified: null },
      session: { userId: "user", sessionToken: "session", expires: new Date(2_000_000_000_000) },
    };
    mocks.getSessionAndUser.mockResolvedValueOnce(known);
    await expect(authConfig.adapter.getSessionAndUser?.("session")).resolves.toEqual(known);
    expect(mocks.getSessionAndUser).toHaveBeenCalledWith("session");
    await expect(
      authConfig.adapter.updateSession?.({ sessionToken: "session" }),
    ).resolves.toBeNull();
    await authConfig.adapter.deleteSession?.("session");
    await expect(
      authConfig.adapter.createSession?.({
        sessionToken: "session",
        userId: "user",
        expires: new Date(0),
      }),
    ).rejects.toThrow("Beta cannot create sessions");
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(mocks.deleteSession).not.toHaveBeenCalled();
    const fetchEmail = vi.fn<typeof fetch>();
    const log = vi.fn();
    await expect(
      sendEmail(
        { from: "fixture", to: "fixture", subject: "fixture", text: "fixture", html: "fixture" },
        { apiKey: "fixture", fetchEmail, log },
      ),
    ).resolves.toEqual({ status: "disabled" });
    expect(fetchEmail).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("stops authenticated profile, progress and review actions before writer calls", async () => {
    vi.stubEnv("EGGHEAD_RUNTIME", "beta");
    const profile = await import("./app/profile/actions");
    const { setLessonCompletion } = await import("./progress/lesson-progress-action");
    const { submitCourseReview } = await import("./progress/course-progress-action");
    await expect(profile.updateProfileName(new FormData())).rejects.toThrow("redirect:/profile");
    await expect(profile.disconnectGithubAccount()).resolves.toEqual({ status: "unauthorized" });
    await expect(
      setLessonCompletion({ resourceId: "lesson", completed: true, source: "lesson_player_ended" }),
    ).resolves.toMatchObject({ status: "failed" });
    await expect(
      submitCourseReview({ courseId: "course", courseSlug: "course", rating: 6, comment: "Good" }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(mocks.updateProfile).not.toHaveBeenCalled();
    expect(mocks.disconnectGithub).not.toHaveBeenCalled();
    expect(mocks.completeLesson).not.toHaveBeenCalled();
    expect(mocks.saveCourseReview).not.toHaveBeenCalled();
  });
});
