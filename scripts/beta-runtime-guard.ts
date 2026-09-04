#!/usr/bin/env bun
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { getCourseBuilderAdapter, getEggheadDatabase } from "../apps/web/src/db/adapter";
import { withAdapterRuntimePolicy } from "../apps/web/src/db/adapter-policy";
import {
  assertAccountWritesAllowed,
  assertCommerceWritesAllowed,
  assertDatabaseUrlForRuntime,
  assertLocalDockerDatabaseUrl,
  assertProgressWritesAllowed,
  getEggheadMysqlPool,
  getRuntimeOperationPermissions,
} from "../apps/web/src/db/local-docker";
import { createCourseBuilderHttpHandler } from "../apps/web/src/coursebuilder/http-policy";
import {
  GET as httpGET,
  POST as httpPOST,
} from "../apps/web/src/app/api/coursebuilder/[...nextCourseBuilder]/route";
import { getMembershipBillingPortalUrl } from "../apps/web/src/subscriptions/billing";

type FrameworkRequest = Parameters<typeof httpGET>[0];
type NextServerBoundary = {
  NextRequest: new (url: string, init?: RequestInit) => FrameworkRequest;
};

function isNextServerBoundary(value: unknown): value is NextServerBoundary {
  return (
    typeof value === "object" &&
    value !== null &&
    "NextRequest" in value &&
    typeof value.NextRequest === "function"
  );
}

// Framework fixtures use the web app's dependency, not a second root Next install.
const nextServer: unknown = createRequire(new URL("../apps/web/package.json", import.meta.url))(
  "next/server",
);
if (!isNextServerBoundary(nextServer)) throw new Error("Next request fixture boundary unavailable");
const { NextRequest } = nextServer;

const environmentKeys = [
  "DATABASE_URL",
  "EGGHEAD_RUNTIME",
  "EGGHEAD_BETA_DB_APPROVED",
  "EGGHEAD_BETA_ACCOUNT_WRITES_APPROVED",
  "EGGHEAD_BETA_PROGRESS_WRITES_APPROVED",
] as const;
const originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
const localUrl = "mysql://root:root@127.0.0.1:3307/coursebuilder_test";
const betaUrl = "mysql://synthetic:synthetic@aws.connect.psdb.cloud/runtime_contract";
const checks: string[] = [];

type Scenario = {
  name: string;
  runtime: string;
  url: string;
  approved: boolean;
  account: boolean;
  progress: boolean;
  expected: { connection: boolean; account: boolean; progress: boolean; commerce: boolean };
};

function setScenario(scenario: Scenario) {
  process.env["DATABASE_URL"] = scenario.url;
  process.env["EGGHEAD_RUNTIME"] = scenario.runtime;
  process.env["EGGHEAD_BETA_DB_APPROVED"] = String(scenario.approved);
  process.env["EGGHEAD_BETA_ACCOUNT_WRITES_APPROVED"] = String(scenario.account);
  process.env["EGGHEAD_BETA_PROGRESS_WRITES_APPROVED"] = String(scenario.progress);
}

async function expectPermission(name: string, allowed: boolean, run: () => unknown) {
  if (allowed) await run();
  else await assert.rejects(async () => run());
  checks.push(name);
}

const denied = { connection: false, account: false, progress: false, commerce: false };
const scenarios: Scenario[] = [
  {
    name: "local",
    runtime: "local",
    url: localUrl,
    approved: false,
    account: false,
    progress: false,
    expected: { connection: true, account: true, progress: true, commerce: true },
  },
  {
    name: "local refuses remote",
    runtime: "local",
    url: betaUrl,
    approved: true,
    account: true,
    progress: true,
    expected: denied,
  },
  {
    name: "unapproved beta",
    runtime: "beta",
    url: betaUrl,
    approved: false,
    account: true,
    progress: true,
    expected: denied,
  },
  {
    name: "approved beta read only",
    runtime: "beta",
    url: betaUrl,
    approved: true,
    account: false,
    progress: false,
    expected: { connection: true, account: false, progress: false, commerce: false },
  },
  {
    name: "approved beta account only",
    runtime: "beta",
    url: betaUrl,
    approved: true,
    account: true,
    progress: false,
    expected: { connection: true, account: true, progress: false, commerce: false },
  },
  {
    name: "approved beta progress only",
    runtime: "beta",
    url: betaUrl,
    approved: true,
    account: false,
    progress: true,
    expected: { connection: true, account: false, progress: true, commerce: false },
  },
  {
    name: "approved beta both",
    runtime: "beta",
    url: betaUrl,
    approved: true,
    account: true,
    progress: true,
    expected: { connection: true, account: true, progress: true, commerce: false },
  },
  {
    name: "beta rejects local target",
    runtime: "beta",
    url: localUrl,
    approved: true,
    account: true,
    progress: true,
    expected: denied,
  },
  {
    name: "production local",
    runtime: "production",
    url: localUrl,
    approved: true,
    account: true,
    progress: true,
    expected: denied,
  },
  {
    name: "production remote",
    runtime: "production",
    url: betaUrl,
    approved: true,
    account: true,
    progress: true,
    expected: denied,
  },
];

try {
  const local = scenarios[0];
  assert.ok(local);
  setScenario(local);
  // mysql2 pools are lazy: construct the real cache without opening a socket.
  const cachedPool = getEggheadMysqlPool();
  const cachedDatabase = getEggheadDatabase();
  const cachedAdapter = getCourseBuilderAdapter();
  assert.equal(getEggheadMysqlPool(), cachedPool);
  assert.equal(getEggheadDatabase(), cachedDatabase);
  const source = { ...cachedAdapter };
  const calls = { read: 0, account: 0, progress: 0, commerce: 0, http: 0, webhook: 0 };
  let expectedReadRequest: Request | null = null;
  source.getProduct = async function getSyntheticProduct(this: typeof source) {
    assert.equal(this, source);
    calls.read++;
    return null;
  };
  source.createVerificationToken = async (token) => {
    calls.account++;
    return token;
  };
  source.completeLessonProgressForUser = async () => {
    calls.progress++;
    return null;
  };
  source.removeMemberFromOrganization = async () => {
    calls.commerce++;
  };
  Object.assign(source, {
    futureMutation: () => {
      throw new Error("Unknown mutation ran");
    },
  });
  const http = createCourseBuilderHttpHandler(
    async () => ({
      GET: async (request) => {
        assert.equal(request, expectedReadRequest);
        calls.http++;
        return Response.json({ ok: true });
      },
      POST: async () => {
        throw new Error("Generic POST must never be delegated");
      },
    }),
    async () => {
      calls.webhook++;
      return Response.json({ ok: true });
    },
  );

  async function runScenario(scenario: Scenario) {
    setScenario(scenario);
    const expected = scenario.expected;
    assert.deepEqual(getRuntimeOperationPermissions(), {
      databaseConnection: expected.connection,
      accountWrites: expected.account,
      progressWrites: expected.progress,
      commerceWrites: expected.commerce,
      billingPortal: expected.commerce,
      stripeWebhook: expected.commerce,
      inngestWrites: expected.commerce,
      ddl: expected.commerce,
    });
    await expectPermission(
      `${scenario.name}: connection`,
      expected.connection,
      assertDatabaseUrlForRuntime,
    );
    await expectPermission(
      `${scenario.name}: account`,
      expected.account,
      assertAccountWritesAllowed,
    );
    await expectPermission(
      `${scenario.name}: progress`,
      expected.progress,
      assertProgressWritesAllowed,
    );
    await expectPermission(
      `${scenario.name}: commerce`,
      expected.commerce,
      assertCommerceWritesAllowed,
    );
    await expectPermission(
      `${scenario.name}: DDL`,
      expected.commerce,
      assertLocalDockerDatabaseUrl,
    );

    const adapter = withAdapterRuntimePolicy(source);
    const before = { ...calls };
    await expectPermission(`${scenario.name}: adapter read`, expected.connection, () =>
      adapter.getProduct("synthetic-product"),
    );
    await expectPermission(`${scenario.name}: adapter account token`, expected.account, () =>
      adapter.createVerificationToken?.({
        identifier: "runtime-contract@example.invalid",
        token: "synthetic-token",
        expires: new Date("2030-01-01T00:00:00.000Z"),
      }),
    );
    await expectPermission(`${scenario.name}: adapter progress`, expected.progress, () =>
      adapter.completeLessonProgressForUser({
        userId: "synthetic-user",
        lessonId: "synthetic-lesson",
      }),
    );
    await expectPermission(`${scenario.name}: adapter commerce`, expected.commerce, () =>
      adapter.removeMemberFromOrganization({
        userId: "synthetic-user",
        organizationId: "synthetic-org",
      }),
    );
    assert.equal(calls.read - before.read, Number(expected.connection));
    assert.equal(calls.account - before.account, Number(expected.account));
    assert.equal(calls.progress - before.progress, Number(expected.progress));
    assert.equal(calls.commerce - before.commerce, Number(expected.commerce));
    assert.equal(Reflect.has(adapter, "futureMutation"), false);
    assert.throws(() => adapter.client);
    assert.equal(Object.keys(adapter).includes("client"), false);
    await assert.rejects(async () =>
      adapter.clearLessonProgressForUser({ userId: "synthetic-user", lessons: [] }),
    );

    const session = new NextRequest("http://localhost/api/coursebuilder/session");
    expectedReadRequest = session;
    assert.equal((await http(session)).status, expected.connection ? 200 : 403);
    const webhook = new Request("http://localhost/api/coursebuilder/webhook/stripe", {
      method: "POST",
      body: "synthetic",
    });
    assert.equal((await http(webhook)).status, expected.commerce ? 200 : 403);
    await (
      [
        ["POST", "checkout"],
        ["POST", "unknown"],
        ["GET", "srt"],
        ["GET", "webhook/stripe"],
      ] as const
    ).reduce(
      (previous, [method, path]) =>
        previous.then(async () => {
          return assert.equal(
            (await http(new Request(`http://localhost/api/coursebuilder/${path}`, { method })))
              .status,
            403,
          );
        }),
      Promise.resolve(),
    );
    assert.equal(calls.http - before.http, Number(expected.connection));
    assert.equal(calls.webhook - before.webhook, Number(expected.commerce));
    if (!expected.commerce) {
      await assert.rejects(() => getMembershipBillingPortalUrl("synthetic-user"));
      const request = new NextRequest("http://localhost/api/coursebuilder/webhook/stripe", {
        method: "POST",
        body: "not-json",
      });
      assert.equal((await httpPOST(request)).status, 403);
      assert.equal(request.bodyUsed, false);
    }
    if (!expected.connection) {
      assert.equal((await httpGET(session)).status, 403);
      assert.throws(() => getEggheadMysqlPool());
      assert.throws(() => getEggheadDatabase());
      assert.throws(() => getCourseBuilderAdapter());
      await assert.rejects(async () => cachedAdapter.getProduct("synthetic-product"));
    }
    if (expected.connection && scenario.url !== localUrl) {
      assert.throws(() => getEggheadMysqlPool(), /target changed/);
      assert.throws(() => getEggheadDatabase(), /target changed/);
    }
    checks.push(`${scenario.name}: callable adapter/HTTP/Portal boundaries`);
  }

  await scenarios.reduce(
    (previous, scenario) => previous.then(() => runScenario(scenario)),
    Promise.resolve(),
  );

  const beta = scenarios.find((scenario) => scenario.name === "approved beta both");
  assert.ok(beta);
  setScenario(beta);
  const approvedAdapter = withAdapterRuntimePolicy(source);
  process.env["EGGHEAD_BETA_ACCOUNT_WRITES_APPROVED"] = "false";
  await assert.rejects(async () =>
    approvedAdapter.createVerificationToken?.({
      identifier: "runtime-contract@example.invalid",
      token: "synthetic-token",
      expires: new Date("2030-01-01T00:00:00.000Z"),
    }),
  );
  await approvedAdapter.completeLessonProgressForUser({
    userId: "synthetic-user",
    lessonId: "synthetic-lesson",
  });
  process.env["EGGHEAD_BETA_PROGRESS_WRITES_APPROVED"] = "false";
  await assert.rejects(async () =>
    approvedAdapter.completeLessonProgressForUser({
      userId: "synthetic-user",
      lessonId: "synthetic-lesson",
    }),
  );
  await approvedAdapter.getProduct("synthetic-product");
  process.env["EGGHEAD_BETA_DB_APPROVED"] = "false";
  await assert.rejects(async () => approvedAdapter.getProduct("synthetic-product"));
  checks.push(
    "cached adapter revalidates connection and independent write approvals on every call",
  );

  setScenario({ ...local, url: "mysql://root:root@127.0.0.1:3307/another_test" });
  assert.throws(() => getEggheadMysqlPool(), /target changed/);
  assert.throws(() => getEggheadDatabase(), /target changed/);
  await assert.rejects(async () => cachedAdapter.getProduct("synthetic-product"), /target changed/);
  checks.push("cached pool, database and adapter reject runtime/target changes");
  setScenario(local);
  await cachedPool.end();
  console.log(
    JSON.stringify({
      ok: true,
      checks,
      evidence: "offline synthetic callable boundaries; no DB or Stripe requests",
    }),
  );
} finally {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
