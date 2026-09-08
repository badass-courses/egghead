import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { appImport, appModule, resetRuntimeEnvironment } from "./fixtures";

const betaUrl = "mysql://synthetic:synthetic@aws.connect.psdb.cloud/runtime_regression";
const approvedBeta = {
  EGGHEAD_RUNTIME: "beta",
  DATABASE_URL: betaUrl,
  EGGHEAD_BETA_DB_APPROVED: "true",
  EGGHEAD_BETA_ACCOUNT_WRITES_APPROVED: "true",
  EGGHEAD_BETA_PROGRESS_WRITES_APPROVED: "true",
};
const delegates: string[] = [];
const permittedDelegates = new Set<string>();
function record(name: string) {
  assert.ok(permittedDelegates.has(name), `Unexpected infrastructure delegate: ${name}`);
  delegates.push(name);
}
function unexpectedInfrastructure(): never {
  throw new Error("Unexpected runtime regression database/network operation");
}
const fakePool = {
  query: unexpectedInfrastructure,
  execute: unexpectedInfrastructure,
  getConnection: unexpectedInfrastructure,
  end: unexpectedInfrastructure,
};
const createPool = mock.fn(() => fakePool);
mock.module(appImport("mysql2/promise"), {
  defaultExport: { createPool, createConnection: unexpectedInfrastructure },
});

const session = {
  sessionToken: "runtime-regression-session",
  userId: "runtime-user",
  expires: new Date("2030-01-01T00:00:00.000Z"),
};
const lesson = { userId: "runtime-user", lessonId: "runtime-lesson" };
const fakePublishedAdapter = {
  async createSession(input: typeof session) {
    record("account.createSession");
    return input;
  },
  async completeLessonProgressForUser(input: typeof lesson) {
    record("progress.completeLesson");
    return { id: "runtime-progress", userId: input.userId, resourceId: input.lessonId };
  },
  async createMerchantCustomer(input: {
    identifier: string;
    merchantAccountId: string;
    userId: string;
  }) {
    record("commerce.createMerchantCustomer");
    return { id: "runtime-customer", ...input };
  },
  async getUser(userId: string) {
    record("account.getUser");
    return { id: userId, email: "runtime@example.test", emailVerified: null };
  },
  async getMembershipsForUser() {
    record("storage.memberships");
    return [{ organizationId: "runtime-org" }];
  },
};
const fakeDatabase = {
  query: {
    entitlements: {
      async findMany() {
        record("storage.entitlements");
        return [];
      },
    },
    subscription: {
      async findMany() {
        record("storage.subscriptions");
        return [
          {
            id: "runtime-subscription",
            organizationId: "runtime-org",
            merchantSubscriptionId: "runtime-merchant-subscription",
            status: "active",
            fields: { ownerId: "runtime-user", subscriptionType: "personal" },
          },
        ];
      },
    },
    merchantSubscription: {
      async findFirst() {
        record("storage.merchantSubscription");
        return { identifier: "sub_runtime", merchantCustomerId: "runtime-customer" };
      },
    },
    merchantCustomer: {
      async findFirst() {
        record("storage.merchantCustomer");
        return { id: "runtime-customer", userId: "runtime-user" };
      },
    },
  },
  execute: unexpectedInfrastructure,
  select: unexpectedInfrastructure,
  insert: unexpectedInfrastructure,
  update: unexpectedInfrastructure,
  delete: unexpectedInfrastructure,
  transaction: unexpectedInfrastructure,
};
mock.module(appImport("drizzle-orm/mysql2"), {
  namedExports: { drizzle: () => fakeDatabase },
});
const publishedAdapterExports: Record<string, unknown> = await import(
  appImport("@coursebuilder/adapter-drizzle/mysql")
);
mock.module(appImport("@coursebuilder/adapter-drizzle/mysql"), {
  namedExports: { ...publishedAdapterExports, mySqlDrizzleAdapter: () => fakePublishedAdapter },
});

class FakeStripePaymentAdapter {
  async getSubscription(identifier: string) {
    record("stripe.getSubscription");
    assert.equal(identifier, "sub_runtime");
    return { customer: "cus_runtime" };
  }
  async getBillingPortalUrl(customerId: string, returnUrl: string) {
    record("stripe.createPortal");
    assert.equal(customerId, "cus_runtime");
    assert.equal(returnUrl, "http://127.0.0.1:3008/profile");
    return "https://billing.stripe.com/p/session/runtime_fixture";
  }
}
mock.module(appImport("@coursebuilder/core/providers/stripe"), {
  namedExports: { StripePaymentAdapter: FakeStripePaymentAdapter },
});
mock.module(appModule("coursebuilder/stripe-provider.ts"), {
  namedExports: {
    getStripeProvider: () => ({ options: { paymentsAdapter: new FakeStripePaymentAdapter() } }),
    getSiteUrl: () => "http://127.0.0.1:3008",
  },
});
mock.module(appModule("coursebuilder/config.ts"), {
  namedExports: {
    handlers: {
      async GET() {
        record("published.GET");
        return Response.json({ delegated: true });
      },
      async POST() {
        record("published.POST");
        return Response.json({ delegated: true });
      },
    },
  },
});

const runtime: typeof import("../../apps/web/src/db/local-docker") = await import(
  appModule("db/local-docker.ts")
);
const database: typeof import("../../apps/web/src/db/adapter") = await import(
  appModule("db/adapter.ts")
);
const billing: typeof import("../../apps/web/src/subscriptions/billing") = await import(
  appModule("subscriptions/billing.ts")
);
const route: {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
} = await import(appModule("app/api/coursebuilder/[...nextCourseBuilder]/route.ts"));

beforeEach(() => {
  resetRuntimeEnvironment(approvedBeta);
  delegates.length = 0;
  permittedDelegates.clear();
});

async function freshPoolBoundary(name: string): Promise<typeof runtime> {
  const url = pathToFileURL(appModule("db/local-docker.ts"));
  url.searchParams.set("regression", name);
  return import(url.href);
}

void test("a cached MySQL pool stops serving after beta database approval is revoked", async () => {
  const isolated = await freshPoolBoundary("pool-revocation");
  const createdBefore = createPool.mock.callCount();
  assert.equal(isolated.getEggheadMysqlPool(), fakePool);
  assert.equal(createPool.mock.callCount(), createdBefore + 1);
  process.env["EGGHEAD_BETA_DB_APPROVED"] = "false";
  assert.throws(() => isolated.getEggheadMysqlPool(), /Refusing beta MySQL URL/);
  assert.equal(createPool.mock.callCount(), createdBefore + 1);
});

void test("a cached MySQL pool refuses a different independently approved database target", async () => {
  const isolated = await freshPoolBoundary("pool-target");
  assert.equal(isolated.getEggheadMysqlPool(), fakePool);
  const createdBefore = createPool.mock.callCount();
  process.env["DATABASE_URL"] = betaUrl.replace("runtime_regression", "replacement_regression");
  isolated.assertDatabaseUrlForRuntime();
  assert.throws(() => isolated.getEggheadMysqlPool(), /target changed.*restart required/i);
  assert.equal(createPool.mock.callCount(), createdBefore);
});

void test("a cached Drizzle database is denied after switching to production runtime", () => {
  assert.equal(database.getEggheadDatabase(), fakeDatabase);
  process.env["EGGHEAD_RUNTIME"] = "production";
  assert.throws(() => database.getEggheadDatabase(), /Refusing production Egghead runtime/);
});

void test("a cached CourseBuilder adapter getter rechecks revoked database approval", () => {
  const cached = database.getCourseBuilderAdapter();
  assert.equal(database.getCourseBuilderAdapter(), cached);
  process.env["EGGHEAD_BETA_DB_APPROVED"] = "false";
  assert.throws(() => database.getCourseBuilderAdapter(), /Refusing beta MySQL URL/);
});

void test("a saved account method cannot spend progress approval after account approval is revoked", async () => {
  permittedDelegates.add("account.createSession");
  permittedDelegates.add("progress.completeLesson");
  const adapter = database.getCourseBuilderAdapter();
  const createSession = adapter.createSession?.bind(adapter);
  assert.ok(createSession);
  await createSession(session);
  process.env["EGGHEAD_BETA_ACCOUNT_WRITES_APPROVED"] = "false";
  await adapter.completeLessonProgressForUser(lesson);
  const callsBefore = [...delegates];
  await assert.rejects(async () => createSession(session), /Refusing account writes/);
  assert.deepEqual(delegates, callsBefore);
  assert.deepEqual(callsBefore, ["account.createSession", "progress.completeLesson"]);
});

void test("a saved progress method cannot spend account approval after progress approval is revoked", async () => {
  permittedDelegates.add("account.createSession");
  permittedDelegates.add("progress.completeLesson");
  const adapter = database.getCourseBuilderAdapter();
  const complete = adapter.completeLessonProgressForUser.bind(adapter);
  await complete(lesson);
  process.env["EGGHEAD_BETA_PROGRESS_WRITES_APPROVED"] = "false";
  const createSession = adapter.createSession?.bind(adapter);
  assert.ok(createSession);
  await createSession(session);
  const callsBefore = [...delegates];
  await assert.rejects(async () => complete(lesson), /Refusing progress writes/);
  assert.deepEqual(delegates, callsBefore);
  assert.deepEqual(callsBefore, ["progress.completeLesson", "account.createSession"]);
});

void test("approving both beta account and progress writes does not authorize cached commerce methods", async () => {
  process.env["EGGHEAD_BETA_ACCOUNT_WRITES_APPROVED"] = "false";
  process.env["EGGHEAD_BETA_PROGRESS_WRITES_APPROVED"] = "false";
  const adapter = database.getCourseBuilderAdapter();
  process.env["EGGHEAD_BETA_ACCOUNT_WRITES_APPROVED"] = "true";
  process.env["EGGHEAD_BETA_PROGRESS_WRITES_APPROVED"] = "true";
  permittedDelegates.add("commerce.createMerchantCustomer");
  await assert.rejects(
    async () =>
      adapter.createMerchantCustomer({
        identifier: "cus_runtime",
        merchantAccountId: "runtime-merchant",
        userId: "runtime-user",
      }),
    /Refusing Egghead commerce writes outside the local Docker runtime/,
  );
  assert.deepEqual(delegates, []);
});

void test("a saved adapter read rejects target replacement without reacquiring the adapter", async () => {
  permittedDelegates.add("account.getUser");
  const adapter = database.getCourseBuilderAdapter();
  const getUser = adapter.getUser?.bind(adapter);
  assert.ok(getUser);
  assert.equal((await getUser("runtime-user"))?.id, "runtime-user");
  process.env["DATABASE_URL"] = betaUrl.replace("runtime_regression", "replacement_regression");
  runtime.assertDatabaseUrlForRuntime();
  await assert.rejects(async () => getUser("runtime-user"), /target changed.*restart required/i);
  assert.deepEqual(delegates, ["account.getUser"]);
});

void test("a saved adapter read rechecks revoked database approval before reaching persistence", async () => {
  permittedDelegates.add("account.getUser");
  const adapter = database.getCourseBuilderAdapter();
  const getUser = adapter.getUser?.bind(adapter);
  assert.ok(getUser);
  assert.equal((await getUser("runtime-user"))?.id, "runtime-user");
  process.env["EGGHEAD_BETA_DB_APPROVED"] = "false";
  await assert.rejects(async () => getUser("runtime-user"), /Refusing beta MySQL URL/);
  assert.deepEqual(delegates, ["account.getUser"]);
});

for (const scenario of [
  {
    name: "unknown HTTP operations",
    method: "POST",
    path: "/api/coursebuilder/unreviewed-operation",
  },
  {
    name: "generic checkout that bypasses the app reservation",
    method: "POST",
    path: "/api/coursebuilder/checkout",
  },
  {
    name: "SRT retrieval that bypasses lesson access",
    method: "GET",
    path: "/api/coursebuilder/srt",
  },
]) {
  void test(`CourseBuilder route denies ${scenario.name} even in local runtime`, async () => {
    resetRuntimeEnvironment();
    permittedDelegates.add("published.GET");
    permittedDelegates.add("published.POST");
    const sessionResponse = await route.GET(
      new Request("http://127.0.0.1:3008/api/coursebuilder/session"),
    );
    assert.equal(sessionResponse.status, 200);
    assert.deepEqual(delegates, ["published.GET"]);
    delegates.length = 0;
    const request = new Request(`http://127.0.0.1:3008${scenario.path}`, {
      method: scenario.method,
    });
    const response = await (scenario.method === "GET" ? route.GET(request) : route.POST(request));
    assert.equal(response.status, 403, "the route must reject before invoking published handlers");
    assert.deepEqual(delegates, []);
  });
}

void test("CourseBuilder Stripe webhook rejects beta writes despite independent account and progress approvals", async () => {
  permittedDelegates.add("published.POST");
  const response = await route.POST(
    new Request("http://127.0.0.1:3008/api/coursebuilder/webhook/stripe", {
      method: "POST",
      body: "synthetic-event-body-must-not-be-parsed",
    }),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(delegates, []);
});

void test("billing Portal creation cannot spend beta account or progress approval", async () => {
  for (const name of [
    "storage.memberships",
    "storage.entitlements",
    "storage.subscriptions",
    "storage.merchantSubscription",
    "storage.merchantCustomer",
    "stripe.getSubscription",
    "stripe.createPortal",
  ])
    permittedDelegates.add(name);
  await assert.rejects(
    () => billing.getMembershipBillingPortalUrl("runtime-user"),
    /Refusing Egghead commerce writes outside the local Docker runtime/,
  );
  assert.deepEqual(delegates, []);
});
