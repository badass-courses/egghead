import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

import { appImport, appModule, resetRuntimeEnvironment } from "./fixtures";

const NOW = Date.parse("2030-01-02T00:00:00.000Z");
const FUTURE = new Date(NOW + 60_000);
const PAST = new Date(NOW - 60_000);
const USER_ID = "access-reader-user";
const ACCESS_CONTEXT = { now: NOW, legacyRailsPlaylistId: 42, requestCountry: "US" };

type EntitlementFixture = {
  entitlementType: string;
  sourceType: string;
  status: string | null;
  sellableId: string | null;
  sellableType: string | null;
  restrictedToCountry: string | null;
  expiresAt: Date | null;
  deletedAt: Date | null;
  isDirectGrant: 0 | 1;
  membershipRole: string | null;
  hasOrganization: 0 | 1;
  hasMembership: 0 | 1;
};

type EntitlementRowFixture = EntitlementFixture & { constructor: { name: "RowDataPacket" } };

function entitlement(overrides: Partial<EntitlementFixture> = {}): EntitlementRowFixture {
  return {
    constructor: { name: "RowDataPacket" },
    entitlementType: "egghead_all_access_subscription",
    sourceType: "stripe_subscription",
    status: "active",
    sellableId: null,
    sellableType: null,
    restrictedToCountry: null,
    expiresAt: FUTURE,
    deletedAt: null,
    isDirectGrant: 1,
    membershipRole: null,
    hasOrganization: 0,
    hasMembership: 0,
    ...overrides,
  };
}

type ResourceFixture = {
  id: string;
  type: string;
  fields: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  position: number;
};

type LessonFixture = {
  lesson: ResourceFixture;
  parent: ResourceFixture | null;
  hasParent: boolean;
  video: ResourceFixture | null;
};

function resource(id: string, type: string, fields: Record<string, unknown>): ResourceFixture {
  return { id, type, fields, createdAt: PAST, updatedAt: PAST, position: 1 };
}

function lessonFixture(id: string, fields: Record<string, unknown> = {}): LessonFixture {
  return {
    lesson: resource(id, "lesson", {
      title: `Lesson ${id}`,
      slug: `slug-${id}`,
      state: "published",
      visibility: "public",
      isProContent: true,
      ...fields,
    }),
    parent: resource("course-fixture", "course", {
      slug: "fixture-course",
      title: "Fixture course",
      state: "published",
      legacyRailsPlaylistId: 42,
    }),
    hasParent: true,
    video: null,
  };
}

type SubscriptionFixture = {
  id: string;
  status: string;
  organizationId: string;
  fields: { ownerId: string; seats: number; subscriptionKind: "personal" | "team" };
};

type SeatFixture = {
  sourceId: string;
  sourceType: string;
  entitlementType: string;
  userId: string;
  deletedAt: Date | null;
  expiresAt: Date | null;
  metadata: { status: string };
};

function subscriptionFixture(ownerId: string, seats = 2): SubscriptionFixture {
  return {
    id: "subscription-fixture",
    status: "active",
    organizationId: "organization-fixture",
    fields: { ownerId, seats, subscriptionKind: seats > 1 ? "team" : "personal" },
  };
}

function seatFixture(overrides: Partial<SeatFixture> = {}): SeatFixture {
  return {
    sourceId: "subscription-fixture",
    sourceType: "stripe_subscription",
    entitlementType: "egghead_all_access_subscription",
    userId: USER_ID,
    deletedAt: null,
    expiresAt: FUTURE,
    metadata: { status: "active" },
    ...overrides,
  };
}

let entitlementRows: EntitlementRowFixture[] = [];
let lessons: LessonFixture[] = [];
let subscriptions: SubscriptionFixture[] = [];
let seats: SeatFixture[] = [];
let memberships: { organizationId: string }[] = [];

function lessonForKey(key: unknown) {
  return lessons.find(
    (fixture) => fixture.lesson.id === key || fixture.lesson.fields["slug"] === key,
  );
}

// SQL only routes fixture result sets. The readers, access evaluator, lesson
// projection, and subscription classification remain real; SQL is not executed.
async function executeFixture(sql: string, params: readonly unknown[] = []) {
  if (sql.includes("FROM egghead_Entitlement entitlement")) return [entitlementRows, []];
  const fixture = lessonForKey(params[0]);
  if (sql.includes("SELECT lesson.id")) return [fixture ? [fixture.lesson] : [], []];
  if (sql.includes("SELECT parent.id")) return [fixture?.parent ? [fixture.parent] : [], []];
  if (sql.includes("AS hasParent")) return [[{ hasParent: fixture?.hasParent ? 1 : 0 }], []];
  if (sql.includes("AS freeRows")) return [[{ freeRows: 0, proRows: 0 }], []];
  if (sql.includes("SELECT video.id")) return [fixture?.video ? [fixture.video] : [], []];
  throw new Error(`Unexpected SQL fixture request: ${sql}`);
}

async function queryFixture(sql: string) {
  if (sql.startsWith("SHOW COLUMNS")) return [[{ Field: "slug" }], []];
  throw new Error(`Unexpected SQL fixture query: ${sql}`);
}

const endConnection = async () => undefined;
const noOp = () => undefined;
const findSubscriptions = async () => subscriptions;
const findSeats = async () => seats;
const findFirstSeat = async () => seats[0];
const findMemberships = async () => memberships;
const databaseFixture = {
  query: {
    subscription: { findMany: findSubscriptions },
    entitlements: { findMany: findSeats, findFirst: findFirstSeat },
  },
};
const adapterFixture = { getMembershipsForUser: findMemberships };

mock.module(appModule("db/local-docker.ts"), {
  namedExports: {
    createLocalMysqlConnection: async () => ({
      execute: executeFixture,
      query: queryFixture,
      end: endConnection,
    }),
    assertCommerceWritesAllowed: noOp,
  },
});
mock.module(appModule("db/adapter.ts"), {
  namedExports: {
    getEggheadDatabase: () => databaseFixture,
    getCourseBuilderAdapter: () => adapterFixture,
  },
});
mock.module(appImport("next/cache"), {
  namedExports: { cacheLife: noOp, cacheTag: noOp },
});

const { evaluateAccessEntitlementRows }: typeof import("../../apps/web/src/access/evaluate") =
  await import(appModule("access/evaluate.ts"));
const { lessonRequiresAccess }: typeof import("../../apps/web/src/content/lesson-access") =
  await import(appModule("content/lesson-access.ts"));
const { getLessonById, getLessonBySlug }: typeof import("../../apps/web/src/content/lesson") =
  await import(appModule("content/lesson.ts"));
const { getCurrentSubscriptionForUser }: typeof import("../../apps/web/src/subscriptions/status") =
  await import(appModule("subscriptions/status.ts"));
const { readSupportAccessForUser }: typeof import("../../apps/web/src/support/readback") =
  await import(appModule("support/readback.ts"));

const fixtureNow = () => NOW;
beforeEach((context) => {
  resetRuntimeEnvironment();
  assert.ok("mock" in context);
  context.mock.method(Date, "now", fixtureNow);
  entitlementRows = [];
  lessons = [];
  subscriptions = [];
  seats = [];
  memberships = [];
});

const rejectedStripeGrants: { name: string; overrides: Partial<EntitlementFixture> }[] = [
  { name: "expired", overrides: { expiresAt: PAST } },
  { name: "at the paid-through boundary", overrides: { expiresAt: new Date(NOW) } },
  { name: "missing a paid-through deadline", overrides: { expiresAt: null } },
  { name: "deleted", overrides: { deletedAt: PAST } },
  {
    name: "organization-only rather than directly assigned",
    overrides: { isDirectGrant: 0, hasOrganization: 1, membershipRole: "member" },
  },
];

for (const { name, overrides } of rejectedStripeGrants) {
  void test(`Stripe access denies a grant that is ${name}`, () => {
    for (const status of ["active", "trialing", "past_due"]) {
      assert.equal(
        evaluateAccessEntitlementRows([entitlement({ status })], ACCESS_CONTEXT).granted,
        true,
        `a directly assigned ${status} grant inside its paid-through period must work`,
      );
    }
    const result = evaluateAccessEntitlementRows([entitlement(overrides)], ACCESS_CONTEXT);
    assert.equal(result.granted, false, `${name} must not authorize a lesson`);
    assert.deepEqual(result.entitlementTypes, []);
    assert.deepEqual(result.sourceTypes, []);
    assert.equal(result.reason, "denied:no_granting_entitlement");
  });
}

for (const status of ["canceled", "cancelled"]) {
  void test(`Legacy account subscription with explicit ${status} status no longer grants access`, () => {
    const legacyGrant = entitlement({ sourceType: "rails_account_subscription", expiresAt: PAST });
    assert.equal(
      evaluateAccessEntitlementRows([legacyGrant], ACCESS_CONTEXT).granted,
      true,
      "an active legacy paid-through projection does not use its stale expiry mirror",
    );
    assert.equal(
      evaluateAccessEntitlementRows([{ ...legacyGrant, status }], ACCESS_CONTEXT).granted,
      false,
      "explicit legacy cancellation overrides the otherwise granting projection",
    );
  });
}

void test("A paid lesson remains gated after losing its parent-course routing metadata", () => {
  const paidLesson = { courseLinked: false, freeForever: false, isProContent: true };
  assert.equal(lessonRequiresAccess({ ...paidLesson, courseLinked: true }), true);
  assert.equal(lessonRequiresAccess({ ...paidLesson, freeForever: true }), false);
  assert.equal(lessonRequiresAccess({ ...paidLesson, isProContent: false }), false);
  assert.equal(lessonRequiresAccess(paidLesson), true, "paid evidence survives a missing parent");
});

void test("The real lesson reader retains access gating when a parent link no longer resolves", async () => {
  const linked = lessonFixture("linked-paid");
  const orphan = lessonFixture("orphan-paid", { isProContent: undefined });
  orphan.parent = null;
  const free = lessonFixture("orphan-free", { isProContent: false });
  free.parent = null;
  lessons = [linked, orphan, free];

  const linkedPage = await getLessonById(linked.lesson.id);
  const freePage = await getLessonById(free.lesson.id);
  assert.ok(linkedPage);
  assert.ok(freePage);
  assert.equal(lessonRequiresAccess(linkedPage), true);
  assert.equal(lessonRequiresAccess(freePage), false, "explicit free marking still wins");

  const orphanPage = await getLessonById(orphan.lesson.id);
  assert.ok(orphanPage);
  assert.equal(orphanPage.parentCourseId, null);
  assert.equal(orphanPage.freeForever, false);
  assert.equal(
    lessonRequiresAccess(orphanPage),
    true,
    "a dangling parent relation is unresolved course evidence, not free access",
  );
});

const publicReaders = [
  { name: "ID", read: getLessonById, key: (fixture: LessonFixture) => fixture.lesson.id },
  {
    name: "slug",
    read: getLessonBySlug,
    key: (fixture: LessonFixture) => String(fixture.lesson.fields["slug"]),
  },
];

for (const reader of publicReaders) {
  void test(`Public lesson lookup by ${reader.name} does not disclose playback before authorization`, async () => {
    const fixture = lessonFixture("private-media", {
      currentVideoHlsUrl: "https://media.invalid/private-lesson.m3u8",
      currentVideoDashUrl: "https://media.invalid/private-lesson.mpd",
    });
    fixture.video = resource("private-video-resource", "videoResource", {
      muxPlaybackId: "private-mux-playback-id",
      duration: 83,
      transcript: "Readable fixture transcript",
    });
    lessons = [fixture];
    assert.equal(await reader.read("missing-lesson"), null);

    const page = await reader.read(reader.key(fixture));
    assert.ok(page);
    assert.equal(page.id, fixture.lesson.id);
    assert.equal(page.title, "Lesson private-media");
    assert.equal(page.duration, 83, "the linked video fixture really participates in projection");
    assert.equal(page.hasTranscript, true);
    assert.equal(lessonRequiresAccess(page), true);
    const serialized = JSON.stringify(page);
    for (const secret of [
      "https://media.invalid/private-lesson.m3u8",
      "https://media.invalid/private-lesson.mpd",
      "private-mux-playback-id",
      "private-video-resource",
    ]) {
      assert.equal(serialized.includes(secret), false, `public props must not include ${secret}`);
    }
  });
}

void test("Subscription readback does not mistake an organization member for a personal subscriber", async () => {
  memberships = [{ organizationId: "organization-fixture" }];
  subscriptions = [subscriptionFixture("personal-owner", 1)];
  assert.equal((await getCurrentSubscriptionForUser("personal-owner"))?.id, "subscription-fixture");
  assert.equal(
    await getCurrentSubscriptionForUser(USER_ID),
    null,
    "sharing the owner's organization is neither ownership nor a direct paid seat",
  );
});

void test("Subscription owner can read their billing subscription without an organization membership", async () => {
  subscriptions = [subscriptionFixture(USER_ID)];
  memberships = [{ organizationId: "organization-fixture" }];
  assert.equal((await getCurrentSubscriptionForUser(USER_ID))?.id, "subscription-fixture");
  memberships = [];
  assert.equal(
    (await getCurrentSubscriptionForUser(USER_ID))?.id,
    "subscription-fixture",
    "explicit ownership does not depend on a seat or membership mirror",
  );
});

void test("A directly assigned paid seat identifies the subscription without an organization membership", async () => {
  subscriptions = [subscriptionFixture("team-owner")];
  seats = [seatFixture()];
  memberships = [{ organizationId: "organization-fixture" }];
  assert.equal((await getCurrentSubscriptionForUser(USER_ID))?.id, "subscription-fixture");
  memberships = [];
  assert.equal(
    (await getCurrentSubscriptionForUser(USER_ID))?.id,
    "subscription-fixture",
    "a direct active paid seat is sufficient subscription provenance",
  );
});

void test("An expired team seat no longer classifies its recipient as a current subscriber", async () => {
  subscriptions = [subscriptionFixture("team-owner")];
  memberships = [{ organizationId: "organization-fixture" }];
  seats = [seatFixture()];
  assert.equal((await getCurrentSubscriptionForUser(USER_ID))?.id, "subscription-fixture");
  seats = [seatFixture({ expiresAt: PAST })];
  assert.equal(await getCurrentSubscriptionForUser(USER_ID), null);
});

void test("An unrelated Stripe entitlement is not classified as a paid subscription seat", async () => {
  subscriptions = [subscriptionFixture("team-owner")];
  memberships = [{ organizationId: "organization-fixture" }];
  seats = [seatFixture()];
  assert.equal((await getCurrentSubscriptionForUser(USER_ID))?.id, "subscription-fixture");
  seats = [seatFixture({ entitlementType: "egghead_playlist_access" })];
  assert.equal(await getCurrentSubscriptionForUser(USER_ID), null);
});

void test("Support readback evaluates the requested playlist and country rather than broad access alone", async () => {
  entitlementRows = [
    entitlement({
      entitlementType: "egghead_playlist_access",
      sourceType: "rails_purchase",
      sellableId: "42",
      sellableType: "Playlist",
      restrictedToCountry: "US",
      expiresAt: null,
    }),
  ];
  assert.equal(evaluateAccessEntitlementRows(entitlementRows, ACCESS_CONTEXT).granted, true);
  const deniedContext = { userId: USER_ID, legacyRailsPlaylistId: 42, requestCountry: "CA" };
  assert.equal((await readSupportAccessForUser(deniedContext)).access.granted, false);
  const allowedContext = { ...deniedContext, requestCountry: "US" };
  const readback = await readSupportAccessForUser(allowedContext);
  assert.equal(
    readback.access.granted,
    true,
    "support must explain the same context-specific grant",
  );
  assert.deepEqual(readback.sourceFamilies.grantSourceTypes, ["rails_purchase"]);
});

void test("Support explanation names the granting source instead of an alphabetically earlier non-grant", async () => {
  entitlementRows = [entitlement({ sourceType: "rails_account_subscription", expiresAt: null })];
  const control = await readSupportAccessForUser({ userId: USER_ID });
  assert.equal(control.access.granted, true);
  assert.equal(
    control.explanation.summary,
    "Access granted by egghead_all_access_subscription from rails_account_subscription.",
  );
  entitlementRows.unshift(
    entitlement({
      entitlementType: "egghead_legacy_pro_quarantine",
      sourceType: "legacy_pro_marker",
      expiresAt: null,
    }),
  );
  const readback = await readSupportAccessForUser({ userId: USER_ID });
  assert.equal(readback.access.granted, true);
  assert.equal(readback.explanation.quarantineVisible, true);
  assert.deepEqual(readback.sourceFamilies.allSourceTypes, [
    "legacy_pro_marker",
    "rails_account_subscription",
  ]);
  assert.equal(
    readback.explanation.summary,
    "Access granted by egghead_all_access_subscription from rails_account_subscription.",
    "a non-granting source must not be presented as the reason access was granted",
  );
});

void test("Support readback exposes an effective Stripe team seat as team access", async () => {
  entitlementRows = [entitlement()];
  const personal = await readSupportAccessForUser({ userId: USER_ID });
  assert.equal(personal.access.granted, true);
  assert.equal(personal.explanation.teamSeatVisible, false);
  entitlementRows = [
    entitlement({ hasOrganization: 1, hasMembership: 1, membershipRole: "member" }),
  ];
  const team = await readSupportAccessForUser({ userId: USER_ID });
  assert.equal(team.access.granted, true);
  assert.equal(team.explanation.teamSeatVisible, true);
  assert.equal(team.teamSeat.organizationSourceVisible, true);
  assert.equal(team.teamSeat.membershipSourceVisible, true);
  assert.deepEqual(team.teamSeat.membershipRoles, ["member"]);
});
