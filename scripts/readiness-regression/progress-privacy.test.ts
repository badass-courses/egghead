import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

import type * as CourseActions from "../../apps/web/src/progress/course-progress-action";
import type * as CourseProgress from "../../apps/web/src/progress/course-progress";
import type * as LessonActions from "../../apps/web/src/progress/lesson-progress-action";
import type * as ProfileData from "../../apps/web/src/profile/data";
import type * as ResourceProgress from "../../apps/web/src/progress/resource-progress";
import { appModule, appRequire, resetRuntimeEnvironment } from "./fixtures";

const now = Date.UTC(2030, 0, 1);
const userId = "learner_regression_0001";
const lessonId = "lesson-regression";
const courseId = "course-regression";
const courseSlug = "regression-course";
const profile = {
  id: userId,
  name: "Private Learner",
  email: "private-learner@example.test",
  image: "https://avatars.githubusercontent.com/u/1234",
  createdAt: new Date("2024-01-01T00:00:00Z"),
};

type ProgressRow = {
  userId: string;
  resourceId: string;
  completedAt: Date | null;
  fields: Record<string, unknown>;
};
let persisted = new Map<string, ProgressRow>();
let failCourseWrite = false;
let failProgressRead = false;
let rollbackCount = 0;
let courseWriteFailures = 0;
let progressReadFailures = 0;
let writes = 0;
let fixtureErrors: string[] = [];

function readString(value: unknown): string {
  assert.equal(typeof value, "string", "SQL fixture parameter must be a string");
  if (typeof value !== "string") throw new Error("Invalid SQL string parameter");
  return value;
}

function jsonFields(value: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readString(value));
  assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  return Object.fromEntries(Object.entries(parsed));
}

// Each connection has its own uncommitted snapshot. Autocommit writes become
// immediately visible; rollback discards only the active transaction's writes.
class ProgressConnection {
  private pending: Map<string, ProgressRow> | null = null;

  async beginTransaction() {
    assert.equal(this.pending, null);
    this.pending = structuredClone(persisted);
  }

  async commit() {
    assert.ok(this.pending);
    persisted = this.pending;
    this.pending = null;
  }

  async rollback() {
    rollbackCount++;
    this.pending = null;
  }

  async end() {
    this.pending = null;
  }

  async execute(sql: string, parameters: readonly unknown[] = []): Promise<[unknown, unknown[]]> {
    const statement = sql.replace(/\s+/g, " ").trim();
    const rows = this.pending ?? persisted;
    if (statement.startsWith("SELECT id FROM egghead_User")) return [[{ id: userId }], []];
    if (statement.includes("FROM egghead_User user")) return [[{ ...profile }], []];
    if (statement.includes("AS activeMonthCount")) {
      return [[{ lessonCount: 1, courseCount: 0, activeMonthCount: 1 }], []];
    }
    if (statement.includes("JOIN egghead_ContentResource resource")) {
      return [
        [
          {
            resourceId: lessonId,
            completedAt: new Date(now),
            type: "lesson",
            fields: {
              title: "Private learning history",
              slug: "private-learning-history",
              state: "published",
            },
          },
        ],
        [],
      ];
    }
    if (statement.includes("AS lessonId")) return [[], []];
    if (statement.includes("COUNT(DISTINCT resourceId) AS completedCount")) {
      const completedCount = parameters
        .slice(1)
        .filter((id) => rows.get(readString(id))?.completedAt).length;
      return [[{ completedCount }], []];
    }
    if (statement.startsWith("SELECT") && statement.includes("FROM egghead_ResourceProgress")) {
      if (failProgressRead) {
        progressReadFailures++;
        throw new Error("Injected progress readback failure");
      }
      const row = rows.get(readString(parameters[1]));
      return [row ? [structuredClone(row)] : [], []];
    }
    if (statement.startsWith("INSERT INTO egghead_ResourceProgress")) {
      const bulk =
        parameters.length > 3 && !(parameters[2] instanceof Date) && parameters[2] !== null;
      const stride = bulk ? 3 : parameters.length;
      for (let offset = 0; offset < parameters.length; offset += stride) {
        const resourceId = readString(parameters[offset + 1]);
        if (resourceId === courseId && failCourseWrite) {
          courseWriteFailures++;
          throw new Error("Injected course reconciliation failure");
        }
        const timestamp = parameters[offset + 2];
        const completedAt =
          timestamp instanceof Date || timestamp === null ? timestamp : new Date(now);
        const fields = jsonFields(
          parameters[offset + (timestamp instanceof Date || timestamp === null ? 3 : 2)],
        );
        const previous = rows.get(resourceId);
        const preserveCompletion = statement.includes("COALESCE(completedAt, VALUES(completedAt))");
        rows.set(resourceId, {
          userId: readString(parameters[offset]),
          resourceId,
          completedAt: preserveCompletion ? (previous?.completedAt ?? completedAt) : completedAt,
          fields: statement.includes("JSON_MERGE_PATCH")
            ? { ...previous?.fields, ...fields }
            : fields,
        });
        writes++;
      }
      return [{ affectedRows: parameters.length / stride }, []];
    }
    if (statement.startsWith("UPDATE egghead_ResourceProgress")) {
      const resourceId = readString(parameters[2]);
      if (resourceId === courseId && failCourseWrite) {
        courseWriteFailures++;
        throw new Error("Injected course reconciliation failure");
      }
      const previous = rows.get(resourceId);
      if (
        !previous ||
        (statement.includes("AND completedAt IS NOT NULL") && !previous.completedAt)
      ) {
        return [{ affectedRows: 0 }, []];
      }
      rows.set(resourceId, {
        ...previous,
        completedAt: statement.includes("SET completedAt = NULL") ? null : previous.completedAt,
        fields: { ...previous.fields, ...jsonFields(parameters[0]) },
      });
      writes++;
      return [{ affectedRows: 1 }, []];
    }
    if (statement.startsWith("UPDATE egghead_User")) {
      profile.name = readString(parameters[0]);
      writes++;
      return [{ affectedRows: 1 }, []];
    }
    fixtureErrors.push(statement);
    throw new Error(`Unexpected fixture SQL: ${statement}`);
  }
}

mock.module(appRequire.resolve("mysql2/promise"), {
  defaultExport: {
    createConnection: async () => new ProgressConnection(),
    createPool: () => new ProgressConnection(),
  },
});
mock.module(appModule("coursebuilder/current-user.ts"), {
  namedExports: { getCurrentUser: async () => ({ id: userId, email: profile.email }) },
});
mock.module(appModule("content/lesson.ts"), {
  namedExports: {
    getLessonById: async (id: string) =>
      id === lessonId
        ? {
            id: lessonId,
            courseLinked: true,
            parentCourseId: courseId,
            parentCourseSlug: courseSlug,
          }
        : null,
  },
});
mock.module(appModule("content/course.ts"), {
  namedExports: {
    getCourseBySlug: async (slug: string) =>
      slug === courseSlug
        ? {
            id: courseId,
            slug: courseSlug,
            lessons: [{ id: lessonId }],
          }
        : null,
  },
});
mock.module(appModule("progress/anonymous-lesson-progress.ts"), {
  namedExports: {
    recordAnonymousLessonCompletion: async () => {
      throw new Error("Authenticated fixture required");
    },
  },
});

// Runtime imports ensure persistence and authenticated-request fixtures are
// installed before either revision initializes the real application modules.
const resource: typeof ResourceProgress = await import(appModule("progress/resource-progress.ts"));
const course: typeof CourseProgress = await import(appModule("progress/course-progress.ts"));
const lessonActions: typeof LessonActions = await import(
  appModule("progress/lesson-progress-action.ts")
);
const courseActions: typeof CourseActions = await import(
  appModule("progress/course-progress-action.ts")
);
const profiles: typeof ProfileData = await import(appModule("profile/data.ts"));

beforeEach((context) => {
  resetRuntimeEnvironment();
  assert.ok("mock" in context);
  context.mock.timers.enable({ apis: ["Date"], now });
  persisted = new Map();
  failCourseWrite = false;
  failProgressRead = false;
  rollbackCount = 0;
  courseWriteFailures = 0;
  progressReadFailures = 0;
  writes = 0;
  fixtureErrors = [];
  profile.name = "Private Learner";
});

function seedCompletedRows() {
  for (const resourceId of [lessonId, courseId]) {
    persisted.set(resourceId, {
      userId,
      resourceId,
      completedAt: new Date(now),
      fields: { source: "fixture" },
    });
  }
}

const betaReadOnly = {
  EGGHEAD_RUNTIME: "beta",
  DATABASE_URL: "mysql://synthetic:synthetic@regression.connect.psdb.cloud/egghead_beta",
  EGGHEAD_BETA_DB_APPROVED: "true",
  EGGHEAD_BETA_ACCOUNT_WRITES_APPROVED: "false",
  EGGHEAD_BETA_PROGRESS_WRITES_APPROVED: "false",
};

for (const scenario of [
  {
    name: "complete one resource",
    run: () =>
      resource.completeResourceForUser({ userId, resourceId: lessonId, source: "regression" }),
  },
  {
    name: "seed resource progress",
    run: () =>
      resource.seedResourceProgress({
        userId,
        resourceId: lessonId,
        completedAt: null,
        source: "regression",
      }),
  },
  {
    name: "remove a completion",
    run: () =>
      resource.uncompleteResourceForUser({ userId, resourceId: lessonId, source: "regression" }),
  },
  {
    name: "complete several resources",
    run: () =>
      resource.completeResourcesForUser({
        userId,
        resourceIds: [lessonId, "another-lesson"],
        source: "regression",
      }),
  },
  {
    name: "reconcile a course",
    run: () => course.syncCourseProgressForUser({ userId, courseId, lessonIds: [lessonId] }),
  },
  {
    name: "save a course review",
    run: () =>
      course.saveCourseReviewForUser({ userId, courseId, rating: 6, comment: "Useful lesson" }),
  },
]) {
  void test(`beta read-only refuses to ${scenario.name}`, async () => {
    seedCompletedRows();
    await scenario.run();
    assert.ok(writes > 0, "the same operation succeeds against local persistence");
    assert.deepEqual(fixtureErrors, []);
    seedCompletedRows();
    const before = structuredClone(persisted);
    const writesBefore = writes;
    resetRuntimeEnvironment(betaReadOnly);
    await assert.rejects(() => scenario.run(), /progress writes/i);
    assert.deepEqual(persisted, before);
    assert.equal(writes, writesBefore);
  });
}

void test("public learner lookup does not disclose an existing account or its learning history", async () => {
  assert.equal(await profiles.getPublicLearnerProfile("not-an-id"), null);
  const result = await profiles.getPublicLearnerProfile(userId);
  assert.deepEqual(fixtureErrors, [], "the populated account fixture must remain readable");
  assert.equal(result, null);
});

void test("public avatar lookup does not disclose an existing account's email-derived gravatar", async (context) => {
  const requests: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    requests.push(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    return new Response(null, { status: 200 });
  });
  const result = await profiles.getPublicProfileGravatarUrl(userId);
  assert.deepEqual(fixtureErrors, []);
  assert.equal(result, null);
  assert.deepEqual(requests, [], "private email hashes must not be sent to an avatar provider");
});

void test("beta read-only refuses an owner's display-name write", async () => {
  const input = { actorUserId: userId, profileUserId: userId, name: "Updated Learner" };
  assert.equal((await profiles.updatePrivateProfileName(input)).updated, true);
  profile.name = "Private Learner";
  resetRuntimeEnvironment(betaReadOnly);
  await assert.rejects(() => profiles.updatePrivateProfileName(input), /account writes/i);
  assert.equal(profile.name, "Private Learner");
});

void test("completing the last lesson also persists course completion", async () => {
  const result = await lessonActions.completeLessonProgress({
    resourceId: lessonId,
    source: "lesson_player_ended",
  });
  assert.equal(result.status, "completed");
  assert.ok(persisted.get(lessonId)?.completedAt);
  assert.ok(
    persisted.get(courseId)?.completedAt,
    "course completion must be committed with the last lesson",
  );
  assert.deepEqual(fixtureErrors, []);
});

void test("removing a lesson completion also invalidates its completed course", async () => {
  seedCompletedRows();
  const result = await lessonActions.uncompleteLessonProgress({ resourceId: lessonId });
  assert.equal(result.status, "uncompleted");
  assert.equal(persisted.get(lessonId)?.completedAt, null);
  assert.equal(persisted.get(courseId)?.completedAt, null);
  assert.deepEqual(fixtureErrors, []);
});

void test("lesson completion rolls back when course reconciliation fails", async () => {
  failCourseWrite = true;
  const result = await lessonActions.completeLessonProgress({
    resourceId: lessonId,
    source: "lesson_player_ended",
  });
  assert.equal(result.status, "failed");
  assert.equal(courseWriteFailures, 1, "the failure must come from the course persistence seam");
  assert.equal(
    persisted.has(lessonId),
    false,
    "a course failure must not leave a completed lesson behind",
  );
  assert.equal(persisted.has(courseId), false);
  assert.equal(rollbackCount, 1);
  assert.deepEqual(fixtureErrors, []);
});

void test("resource completion rolls back its write when readback fails", async () => {
  failProgressRead = true;
  await assert.rejects(
    () => resource.completeResourceForUser({ userId, resourceId: lessonId, source: "regression" }),
    /Injected progress readback failure/,
  );
  assert.equal(progressReadFailures, 1);
  assert.equal(writes, 1, "the write must have occurred before the injected read failure");
  assert.equal(
    persisted.has(lessonId),
    false,
    "failed completion must not survive in autocommit storage",
  );
  assert.equal(rollbackCount, 1);
});

void test("review submission reconciles completed lessons before saving the review", async () => {
  persisted.set(lessonId, { userId, resourceId: lessonId, completedAt: new Date(now), fields: {} });
  const result = await courseActions.submitCourseReview({
    courseId,
    courseSlug,
    rating: 6,
    comment: "Useful lesson",
  });
  assert.equal(result.status, "saved");
  assert.ok(persisted.get(courseId)?.completedAt);
  assert.deepEqual(persisted.get(courseId)?.fields["review"], {
    rating: 6,
    comment: "Useful lesson",
    submittedAt: new Date(now).toISOString(),
  });
  assert.deepEqual(fixtureErrors, []);
});

void test("an emptied curriculum clears stale course completion", async () => {
  seedCompletedRows();
  const result = await course.syncCourseProgressForUser({ userId, courseId, lessonIds: [] });
  assert.equal(result.completed, false);
  assert.equal(persisted.get(courseId)?.completedAt, null);
  assert.deepEqual(fixtureErrors, []);
});
