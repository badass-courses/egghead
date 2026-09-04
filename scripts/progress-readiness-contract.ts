#!/usr/bin/env bun
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock } from "node:test";

import PublicProfilePage, { metadata } from "../apps/web/src/app/profile/[publicId]/page";
import OpenGraphImage from "../apps/web/src/app/profile/[publicId]/opengraph-image";
import { assertAccountWritesAllowed } from "../apps/web/src/db/local-docker";
import { claimProgressAfterAuthentication } from "../apps/web/src/progress/authenticated-progress-claim";
import {
  getPrivateAccountProfile,
  getPrivateLearningProgress,
  getPublicLearnerProfile,
  getPublicProfileGravatarUrl,
  updatePrivateProfileName,
} from "../apps/web/src/profile/data";
import {
  saveCourseReviewForUser,
  syncCourseProgressForUser,
} from "../apps/web/src/progress/course-progress";
import { writeLessonProgressForUser } from "../apps/web/src/progress/lesson-progress";
import {
  completeResourceForUser,
  completeResourcesForUser,
  ensureLocalResourceProgressTable,
  seedResourceProgress,
  uncompleteResourceForUser,
} from "../apps/web/src/progress/resource-progress";

// Resolve the app's exact mysql2 instance, without adding a second dependency.
// Only the connection boundary is mocked; the actual writers and transaction run.
interface MysqlBoundary {
  createConnection: (...args: unknown[]) => Promise<unknown>;
  createPool: (...args: unknown[]) => unknown;
}
function isMysqlBoundary(value: unknown): value is MysqlBoundary {
  return (
    typeof value === "object" &&
    value !== null &&
    "createConnection" in value &&
    typeof value.createConnection === "function" &&
    "createPool" in value &&
    typeof value.createPool === "function"
  );
}
const mysqlPackage: unknown = createRequire(new URL("../apps/web/package.json", import.meta.url))(
  "mysql2/promise",
);
if (!isMysqlBoundary(mysqlPackage)) throw new Error("App MySQL test boundary is unavailable");

const environmentKeys = [
  "EGGHEAD_RUNTIME",
  "DATABASE_URL",
  "EGGHEAD_BETA_DB_APPROVED",
  "EGGHEAD_BETA_ACCOUNT_WRITES_APPROVED",
  "EGGHEAD_BETA_PROGRESS_WRITES_APPROVED",
] as const;
const environment = environmentKeys.map((key) => [key, process.env[key]] as const);
const userId = "synthetic-progress-owner";
const resourceId = "synthetic-progress-lesson";
const courseId = "synthetic-progress-course";
const completionDate = new Date("2026-08-01T12:00:00.000Z");
const input = { userId, resourceId, source: "readiness_contract" };
const curriculum = { courseId, lessonIds: [resourceId, "synthetic-other-lesson"] };
const checks: string[] = [];
let connectionAttempts = 0;
let responses: unknown[] = [];
let events: string[] = [];
let responseIndex = 0;
let parametersByCall: (readonly unknown[])[] = [];

mock.method(mysqlPackage, "createPool", () => {
  throw new Error("Unexpected pool access in offline contract");
});
mock.method(mysqlPackage, "createConnection", () => {
  connectionAttempts += 1;
  return Promise.resolve({
    beginTransaction() {
      events.push("begin");
      return Promise.resolve();
    },
    execute(_sql: string, parameters: readonly unknown[] = []) {
      parametersByCall.push(parameters);
      events.push("execute");
      if (responseIndex >= responses.length) throw new Error("Unexpected database operation");
      const response = responses[responseIndex++];
      if (response instanceof Error) return Promise.reject(response);
      return Promise.resolve([response, []]);
    },
    commit() {
      events.push("commit");
      return Promise.resolve();
    },
    rollback() {
      events.push("rollback");
      return Promise.resolve();
    },
    end() {
      events.push("end");
      return Promise.resolve();
    },
  });
});

function scenario(nextResponses: unknown[]) {
  responses = nextResponses;
  responseIndex = 0;
  events = [];
  parametersByCall = [];
}

async function main() {
  try {
    process.env["EGGHEAD_RUNTIME"] = "beta";
    process.env["DATABASE_URL"] = "mysql://synthetic:synthetic@aws.connect.psdb.cloud/synthetic";
    process.env["EGGHEAD_BETA_DB_APPROVED"] = "true";
    delete process.env["EGGHEAD_BETA_ACCOUNT_WRITES_APPROVED"];
    delete process.env["EGGHEAD_BETA_PROGRESS_WRITES_APPROVED"];

    assert.equal(await getPublicLearnerProfile(userId), null);
    assert.equal(await getPublicProfileGravatarUrl(userId), null);
    assert.throws(() => PublicProfilePage());
    assert.throws(() => OpenGraphImage());
    assert.deepEqual(metadata.robots, { index: false, follow: false });
    assert.equal(connectionAttempts, 0);
    checks.push("public data, page, metadata and OG disclose nothing before database access");

    await assert.rejects(() =>
      getPrivateAccountProfile({
        actorUserId: "synthetic-other-actor",
        profileUserId: userId,
        requestCountry: null,
        emailAuthConfigured: false,
      }),
    );
    await assert.rejects(() =>
      getPrivateLearningProgress({
        actorUserId: "synthetic-other-actor",
        profileUserId: userId,
        query: { order: "newest", page: 1 },
      }),
    );
    await assert.rejects(() =>
      updatePrivateProfileName({
        actorUserId: "synthetic-other-actor",
        profileUserId: userId,
        name: "Synthetic learner",
      }),
    );
    assert.equal(connectionAttempts, 0);
    checks.push("another actor cannot read private profiles or progress or update the owner");

    await assert.rejects(
      () =>
        updatePrivateProfileName({
          actorUserId: userId,
          profileUserId: userId,
          name: "Synthetic learner",
        }),
      /account writes/i,
    );
    const blockedWrites = [
      () => completeResourceForUser(input),
      () => uncompleteResourceForUser(input),
      () => completeResourcesForUser({ userId, resourceIds: [resourceId], source: input.source }),
      () => seedResourceProgress({ ...input, completedAt: completionDate }),
      () => syncCourseProgressForUser({ userId, ...curriculum }),
      () => saveCourseReviewForUser({ userId, courseId, rating: 5, comment: "Synthetic review" }),
      () => writeLessonProgressForUser({ ...input, completed: true, courses: [curriculum] }),
    ];
    await Promise.all(blockedWrites.map((write) => assert.rejects(write, /progress writes/i)));
    await assert.rejects(() => ensureLocalResourceProgressTable());
    assert.equal(connectionAttempts, 0);
    checks.push(
      "account, progress, batch, review and DDL policy assertions precede connection access",
    );

    process.env["EGGHEAD_BETA_ACCOUNT_WRITES_APPROVED"] = "true";
    assertAccountWritesAllowed();
    let claimInvoked = false;
    const deferredClaim = await claimProgressAfterAuthentication(() => {
      claimInvoked = true;
      return Promise.resolve({ status: "claimed", claimedLessonIds: [resourceId] });
    });
    assert.deepEqual(deferredClaim, { status: "deferred", claimedLessonIds: [] });
    assert.equal(claimInvoked, false);
    assert.equal(connectionAttempts, 0);
    checks.push(
      "approved account authentication skips denied progress claims before cookie access",
    );

    process.env["EGGHEAD_BETA_PROGRESS_WRITES_APPROVED"] = "true";
    scenario([[{ id: userId }], { affectedRows: 1 }]);
    await completeResourcesForUser({ userId, resourceIds: [resourceId], source: input.source });
    const serializedFields = parametersByCall[1]?.[2];
    assert.equal(typeof serializedFields, "string");
    if (typeof serializedFields !== "string") throw new Error("Progress fields were not written");
    const writtenFields: unknown = JSON.parse(serializedFields);
    assert.deepEqual(writtenFields, { source: input.source, localOnly: false });
    checks.push("approved beta progress writes do not claim local-only provenance");

    process.env["EGGHEAD_RUNTIME"] = "local";
    process.env["DATABASE_URL"] = "mysql://root:root@127.0.0.1:3307/coursebuilder_test";
    const failedClaim = await claimProgressAfterAuthentication(() =>
      Promise.reject(new Error("Synthetic anonymous claim failure")),
    );
    assert.deepEqual(failedClaim, { status: "failed", claimedLessonIds: [] });
    const retainedClaim = await claimProgressAfterAuthentication(() =>
      Promise.resolve({ status: "claimed_cookie_retained", claimedLessonIds: [resourceId] }),
    );
    assert.equal(retainedClaim.status, "claimed_cookie_retained");
    assert.deepEqual(retainedClaim.claimedLessonIds, [resourceId]);
    checks.push(
      "failed claim and postcommit cookie retention return explicit results without rejecting authentication",
    );
    scenario([
      [{ id: userId }],
      { affectedRows: 1 },
      [{ userId, resourceId, completedAt: completionDate, fields: {} }],
      [{ completedCount: 2 }],
      { affectedRows: 1 },
      [{ completedAt: completionDate, fields: {} }],
    ]);
    const completed = await writeLessonProgressForUser({
      ...input,
      completed: true,
      courses: [curriculum],
    });
    assert.equal(completed.state.completedAt, completionDate.toISOString());
    assert.equal(completed.course?.completed, true);
    assert.equal(completed.course?.emptyCourse, false);
    assert.deepEqual(events, [
      "begin",
      "execute",
      "execute",
      "execute",
      "execute",
      "execute",
      "execute",
      "commit",
      "end",
    ]);
    checks.push("last lesson and course state are returned only after one shared commit");

    scenario([
      [{ id: userId }],
      { affectedRows: 1 },
      [{ userId, resourceId, completedAt: null, fields: {} }],
      [{ completedCount: 1 }],
      { affectedRows: 1 },
      [{ completedAt: null, fields: {} }],
    ]);
    const uncompleted = await writeLessonProgressForUser({
      ...input,
      completed: false,
      courses: [curriculum],
    });
    assert.equal(uncompleted.state.completed, false);
    assert.equal(uncompleted.course?.completed, false);
    assert.deepEqual(events.slice(-2), ["commit", "end"]);
    assert.equal(events.filter((event) => event === "begin").length, 1);
    checks.push("uncomplete and course reconciliation share the same transaction");

    scenario([
      [{ id: userId }],
      { affectedRows: 1 },
      [{ userId, resourceId, completedAt: completionDate, fields: {} }],
      new Error("Synthetic course synchronization failure"),
    ]);
    await assert.rejects(
      () => writeLessonProgressForUser({ ...input, completed: true, courses: [curriculum] }),
      /Synthetic course/,
    );
    assert.equal(events.includes("commit"), false);
    assert.deepEqual(events.slice(-2), ["rollback", "end"]);
    checks.push("course synchronization failure rolls back the lesson without reporting success");

    scenario([[{ id: userId }], { affectedRows: 1 }, [{ completedAt: null, fields: {} }]]);
    const empty = await syncCourseProgressForUser({ userId, courseId, lessonIds: [] });
    assert.deepEqual(empty, {
      completed: false,
      completedAt: null,
      reviewSubmitted: false,
      emptyCourse: true,
    });
    assert.equal(responseIndex, 3);
    assert.deepEqual(events.slice(-2), ["commit", "end"]);
    checks.push(
      "empty curriculum performs stale-completion reconciliation and reports empty explicitly",
    );

    scenario([[]]);
    await assert.rejects(() => completeResourceForUser(input), /account is unavailable/);
    assert.deepEqual(events, ["begin", "execute", "rollback", "end"]);
    checks.push("missing account aborts before a progress write");

    console.log(
      JSON.stringify({
        ok: true,
        checks,
        scope: "offline transaction and privacy contracts; synthetic database responses",
        realDatabasePersistenceExercised: false,
        externalCallsPerformed: false,
      }),
    );
  } finally {
    mock.restoreAll();
    for (const [key, value] of environment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Learning readiness contract failed");
  process.exitCode = 1;
});
