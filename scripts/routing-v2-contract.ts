import { courseAccessFromFields } from "../apps/web/src/content/course-access";
import { COURSE_LESSON_STATIC_PARAM_LIMIT } from "../apps/web/src/content/course";
import {
  ACCESS_ENTITLEMENT_ROWS_SQL,
  evaluateAccessEntitlementRows,
  type AccessEntitlement,
  entitlementGrantsAccess,
  normalizeRequestCountry,
} from "../apps/web/src/access/evaluate";
import { selectCurrentSubscriptionForUser } from "../apps/web/src/subscriptions/status";
import { supportAccessReadbackFromRows } from "../apps/web/src/support/readback";
import { getLessonPlaybackForAccess, lessonForPageFromRows } from "../apps/web/src/content/lesson";
import { lessonCanonicalPathForRouteContext } from "../apps/web/src/content/lesson-route-context";
import {
  lessonAccessFromFields,
  lessonFreeForeverFromFields,
  lessonHasRailsProContentSignal,
  lessonRequiresAccess,
} from "../apps/web/src/content/lesson-access";
import { LESSON_STATIC_PARAM_LIMIT } from "../apps/web/src/content/publication";
import {
  canonicalPodcastPath,
  collectionEntryPath,
  collectionPath,
  legacyCoursePath,
  legacyLessonEmbedPath,
  legacyLessonPath,
  legacyPublicContentPath,
  STANDALONE_PUBLIC_CONTENT_FAMILIES,
  standaloneContentPath,
} from "../apps/web/src/content/routes";

function assertEqual(name: string, actual: string | boolean, expected: string | boolean) {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${String(expected)}, got ${String(actual)}`);
  }

  return { name, pass: true as const };
}

function assertNumberEqual(name: string, actual: number, expected: number) {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${String(expected)}, got ${String(actual)}`);
  }

  return { name, pass: true as const };
}

function assertIncludes(name: string, actual: string, expected: string) {
  if (!actual.includes(expected)) {
    throw new Error(`${name}: expected string to include ${expected}`);
  }

  return { name, pass: true as const };
}

function assertNotIncludes(name: string, values: readonly string[], blocked: string) {
  if (values.includes(blocked)) {
    throw new Error(`${name}: did not expect ${blocked} in ${JSON.stringify(values)}`);
  }

  return { name, pass: true as const };
}

const cohortNow = Date.UTC(2030, 0, 15);
const futureBoundary = new Date(cohortNow + 60_000);
const pastBoundary = new Date(cohortNow - 60_000);
const cohortUserId = "synthetic-learner";
const personalSubscription = {
  id: "synthetic-personal",
  status: "active",
  fields: { ownerId: cohortUserId, seats: 1, subscriptionKind: "personal" },
};
const teamSubscription = {
  id: "synthetic-team",
  status: "active",
  fields: { ownerId: "synthetic-owner", seats: 4, subscriptionKind: "team" },
};
const memberSeat = {
  sourceId: teamSubscription.id,
  sourceType: "stripe_subscription",
  entitlementType: "egghead_all_access_subscription",
  userId: cohortUserId,
  deletedAt: null,
  expiresAt: futureBoundary,
  metadata: { status: "active" },
};

function cohortEntitlement(overrides: Partial<AccessEntitlement> = {}): AccessEntitlement {
  return {
    entitlementType: "egghead_all_access_subscription",
    sourceType: "stripe_subscription",
    status: "active",
    sellableId: null,
    sellableType: null,
    restrictedToCountry: null,
    expiresAt: futureBoundary,
    deletedAt: null,
    isDirectGrant: 1,
    ...overrides,
  };
}

const entitlementCohorts = [
  { name: "personal subscriber", rows: [cohortEntitlement()], granted: true },
  { name: "unseated team owner", rows: [], granted: false },
  { name: "seated team member", rows: [cohortEntitlement({ hasMembership: 1 })], granted: true },
  {
    name: "removed member",
    rows: [cohortEntitlement({ deletedAt: pastBoundary })],
    granted: false,
  },
  {
    name: "expired member",
    rows: [cohortEntitlement({ expiresAt: pastBoundary })],
    granted: false,
  },
  {
    name: "boundary-expired member",
    rows: [cohortEntitlement({ expiresAt: new Date(cohortNow) })],
    granted: false,
  },
  { name: "org-only member", rows: [cohortEntitlement({ isDirectGrant: 0 })], granted: false },
  {
    name: "seat without paid-through proof",
    rows: [cohortEntitlement({ expiresAt: null })],
    granted: false,
  },
  {
    name: "failed payment retains proven boundary",
    rows: [cohortEntitlement({ status: "past_due" })],
    granted: true,
  },
  {
    name: "failed payment past proven boundary",
    rows: [cohortEntitlement({ status: "past_due", expiresAt: pastBoundary })],
    granted: false,
  },
  {
    name: "terminal canceled legacy",
    rows: [cohortEntitlement({ sourceType: "rails_account_subscription", status: "canceled" })],
    granted: false,
  },
  {
    name: "terminal cancelled legacy alias",
    rows: [cohortEntitlement({ sourceType: "rails_account_subscription", status: " Cancelled " })],
    granted: false,
  },
  {
    name: "legacy importer expiry contract",
    rows: [
      cohortEntitlement({ sourceType: "rails_account_subscription", expiresAt: pastBoundary }),
    ],
    granted: true,
  },
  {
    name: "legacy importer missing status contract",
    rows: [
      cohortEntitlement({
        sourceType: "rails_account_subscription",
        status: null,
        expiresAt: pastBoundary,
      }),
    ],
    granted: true,
  },
  {
    name: "lifetime",
    rows: [
      cohortEntitlement({
        entitlementType: "egghead_lifetime_access",
        sourceType: "synthetic_lifetime",
        status: null,
        expiresAt: null,
      }),
    ],
    granted: true,
  },
  {
    name: "quarantine",
    rows: [
      cohortEntitlement({
        entitlementType: "egghead_legacy_pro_quarantine",
        sourceType: "synthetic_legacy",
        status: null,
        expiresAt: null,
      }),
    ],
    granted: false,
  },
];

const checks = [
  assertEqual(
    "course canonical path is root collection slug",
    collectionPath("modern-three-js"),
    "/modern-three-js",
  ),
  assertEqual(
    "course lesson canonical path is collection child",
    collectionEntryPath("modern-three-js", "camera-and-renderer"),
    "/modern-three-js/camera-and-renderer",
  ),
  assertEqual(
    "standalone content path is root slug",
    standaloneContentPath("jq-read-json"),
    "/jq-read-json",
  ),
  assertNotIncludes(
    "standalone content families exclude retired guides",
    STANDALONE_PUBLIC_CONTENT_FAMILIES,
    "guide",
  ),
  assertNotIncludes(
    "standalone content families exclude retired projects",
    STANDALONE_PUBLIC_CONTENT_FAMILIES,
    "project",
  ),
  assertNotIncludes(
    "standalone content families exclude migrated tips",
    STANDALONE_PUBLIC_CONTENT_FAMILIES,
    "tip",
  ),
  assertEqual(
    "podcast show canonical path is root show slug",
    canonicalPodcastPath("developer-chats", null, "podcast-show"),
    "/developer-chats",
  ),
  assertEqual(
    "podcast episode canonical path is show child",
    canonicalPodcastPath(
      "alex-reardon-on-balancing-work-life-and-large-side-projects",
      "developer-chats",
      "podcast-episode",
    ),
    "/developer-chats/alex-reardon-on-balancing-work-life-and-large-side-projects",
  ),
  assertEqual(
    "podcast without show evidence remains root single",
    canonicalPodcastPath(
      "full-stack-signals-in-solid-ai-development-and-the-future-of-web-frameworks~moysy",
      null,
      "podcast",
    ),
    "/full-stack-signals-in-solid-ai-development-and-the-future-of-web-frameworks~moysy",
  ),
  assertEqual(
    "legacy course path is preserved",
    legacyCoursePath("modern-three-js"),
    "/courses/modern-three-js",
  ),
  assertEqual(
    "legacy lesson path is preserved",
    legacyLessonPath("camera-and-renderer"),
    "/lessons/camera-and-renderer",
  ),
  assertEqual(
    "legacy lesson embed path is preserved",
    legacyLessonEmbedPath("camera-and-renderer"),
    "/lessons/camera-and-renderer/embed",
  ),
  assertEqual(
    "course-linked discovery lesson href is canonical collection child",
    lessonCanonicalPathForRouteContext("camera-and-renderer", "modern-three-js"),
    "/modern-three-js/camera-and-renderer",
  ),
  assertEqual(
    "standalone discovery lesson href is root single",
    lessonCanonicalPathForRouteContext("camera-and-renderer", null),
    "/camera-and-renderer",
  ),
  assertEqual(
    "legacy talk path is preserved",
    legacyPublicContentPath("talk", "conf-talk"),
    "/talks/conf-talk",
  ),
  assertEqual(
    "Rails free course is labeled free",
    courseAccessFromFields({ accessState: "free" }),
    "free",
  ),
  assertEqual(
    "Rails pro course is labeled pro",
    courseAccessFromFields({ accessState: "pro" }),
    "pro",
  ),
  assertEqual(
    "CourseBuilder-native free course is labeled free",
    courseAccessFromFields({ access: "free" }),
    "free",
  ),
  assertEqual(
    "migrated free course is labeled free",
    courseAccessFromFields({ freeForever: true, visibility: "public" }),
    "free",
  ),
  assertEqual("course with no access marker defaults to pro", courseAccessFromFields({}), "pro"),
  assertEqual(
    "course-linked paid lessons require access",
    lessonRequiresAccess({ courseLinked: true, freeForever: false }),
    true,
  ),
  assertEqual(
    "standalone lessons do not require pro access",
    lessonRequiresAccess({ courseLinked: false, freeForever: false }),
    false,
  ),
  assertEqual(
    "free course-linked lessons do not require pro access",
    lessonRequiresAccess({ courseLinked: true, freeForever: true }),
    false,
  ),
  // Realistic served-DB field shapes. Rails `free_forever` truth arrived under
  // several field names depending on the importer generation; the access law
  // must resolve all of them, not just `freeForever`.
  assertEqual(
    "migration-import free lesson (freeAccess only, no freeForever) is free",
    lessonFreeForeverFromFields({ freeAccess: true, visibility: "public" }),
    true,
  ),
  assertEqual(
    "migration-import free lesson in a pro course does not require access",
    lessonRequiresAccess({
      courseLinked: true,
      freeForever: lessonFreeForeverFromFields({ freeAccess: true, visibility: "public" }),
    }),
    false,
  ),
  assertEqual(
    "migration-import pro lesson (freeAccess false) requires access",
    lessonRequiresAccess({
      courseLinked: true,
      freeForever: lessonFreeForeverFromFields({ freeAccess: false, visibility: "pro" }),
    }),
    true,
  ),
  assertEqual(
    "rehearsal-layer free lesson (freeForever only) is free",
    lessonFreeForeverFromFields({ accessState: "public", freeForever: true, isProContent: false }),
    true,
  ),
  assertEqual(
    "rails isProContent=false wins over older freeAccess false mirror",
    lessonFreeForeverFromFields({
      accessState: "public",
      freeAccess: false,
      freeForever: false,
      isProContent: false,
      visibility: "pro",
    }),
    true,
  ),
  assertEqual(
    "rails pro-content signal is detectable on preserved rows",
    lessonHasRailsProContentSignal({ access: "pro", isProContent: false }),
    true,
  ),
  assertEqual(
    "missing rails pro-content signal stays detectable as missing",
    lessonHasRailsProContentSignal({ access: "pro", freeAccess: false }),
    false,
  ),
  assertEqual(
    "rails isProContent=true wins over inflated rehearsal freeForever",
    lessonFreeForeverFromFields({
      accessState: "public",
      freeForever: true,
      isProContent: true,
      visibility: "pro",
    }),
    false,
  ),
  assertEqual(
    "coursebuilder-native pro post (access 'pro') is not free",
    lessonFreeForeverFromFields({ access: "pro" }),
    false,
  ),
  assertEqual(
    "coursebuilder-native free post (access 'free') is free",
    lessonFreeForeverFromFields({ access: "free" }),
    true,
  ),
  assertEqual(
    "course-linked lesson with no gating fields gates by default",
    lessonRequiresAccess({ courseLinked: true, freeForever: lessonFreeForeverFromFields({}) }),
    true,
  ),
  assertNumberEqual(
    "course lesson static params use the shared lesson budget",
    COURSE_LESSON_STATIC_PARAM_LIMIT,
    LESSON_STATIC_PARAM_LIMIT,
  ),
  assertIncludes(
    "access evaluator joins org entitlements only through account-member role",
    ACCESS_ENTITLEMENT_ROWS_SQL,
    "$.hasAccountMemberRole",
  ),
  assertIncludes(
    "access evaluator exempts subscription rows from generic expiresAt gating",
    ACCESS_ENTITLEMENT_ROWS_SQL,
    "entitlement.sourceType = ?",
  ),
  assertIncludes(
    "access evaluator reads purchase country restriction",
    ACCESS_ENTITLEMENT_ROWS_SQL,
    "$.restrictedToCountry",
  ),
  assertEqual("request country trims whitespace", normalizeRequestCountry(" US ") ?? "", "US"),
  assertEqual(
    "broad subscription entitlement grants",
    entitlementGrantsAccess(
      {
        entitlementType: "egghead_all_access_subscription",
        sellableId: null,
        sellableType: null,
      },
      {},
    ),
    true,
  ),
  assertEqual(
    "legacy basic entitlement grants",
    entitlementGrantsAccess(
      {
        entitlementType: "egghead_basic_legacy_access",
        sellableId: null,
        sellableType: null,
      },
      {},
    ),
    true,
  ),
  assertEqual(
    "unrestricted matching playlist purchase grants",
    entitlementGrantsAccess(
      {
        entitlementType: "egghead_playlist_access",
        restrictedToCountry: null,
        sellableId: "432727",
        sellableType: "Playlist",
      },
      { legacyRailsPlaylistId: 432727 },
    ),
    true,
  ),
  assertEqual(
    "country-restricted matching playlist grants in matching country",
    entitlementGrantsAccess(
      {
        entitlementType: "egghead_playlist_access",
        restrictedToCountry: "IN",
        sellableId: "432727",
        sellableType: "Playlist",
      },
      { legacyRailsPlaylistId: 432727, requestCountry: "IN" },
    ),
    true,
  ),
  assertEqual(
    "country-restricted playlist denies when request country is unknown",
    entitlementGrantsAccess(
      {
        entitlementType: "egghead_playlist_access",
        restrictedToCountry: "IN",
        sellableId: "432727",
        sellableType: "Playlist",
      },
      { legacyRailsPlaylistId: 432727 },
    ),
    false,
  ),
  assertEqual(
    "playlist purchase denies for a different course",
    entitlementGrantsAccess(
      {
        entitlementType: "egghead_playlist_access",
        restrictedToCountry: null,
        sellableId: "432727",
        sellableType: "Playlist",
      },
      { legacyRailsPlaylistId: 432602 },
    ),
    false,
  ),
];

for (const cohort of entitlementCohorts) {
  const context = { now: cohortNow };
  const access = evaluateAccessEntitlementRows(cohort.rows, context);
  const support = supportAccessReadbackFromRows(cohort.rows, context);
  checks.push(
    assertEqual(`${cohort.name}: effective access`, access.granted, cohort.granted),
    assertEqual(`${cohort.name}: support agrees`, support.access.granted, access.granted),
    assertEqual(`${cohort.name}: support reason agrees`, support.access.reason, access.reason),
    assertEqual(
      `${cohort.name}: support granting sources agree`,
      JSON.stringify(support.sourceFamilies.grantSourceTypes),
      JSON.stringify(access.sourceTypes),
    ),
  );
}

const playlistGrant = cohortEntitlement({
  entitlementType: "egghead_playlist_access",
  sourceType: "synthetic_purchase",
  status: null,
  expiresAt: null,
  sellableType: "Playlist",
  sellableId: "synthetic-playlist",
  restrictedToCountry: "IN",
});
for (const country of ["IN", "US", null]) {
  const context = {
    legacyRailsPlaylistId: "synthetic-playlist",
    requestCountry: country,
    now: cohortNow,
  };
  const access = evaluateAccessEntitlementRows([playlistGrant], context);
  const support = supportAccessReadbackFromRows([playlistGrant], context);
  checks.push(
    assertEqual(
      `playlist country ${country ?? "unknown"}: access`,
      access.granted,
      country === "IN",
    ),
    assertEqual(
      `playlist country ${country ?? "unknown"}: support agrees`,
      support.access.granted,
      access.granted,
    ),
  );
}

const mixedReadback = supportAccessReadbackFromRows(
  [
    cohortEntitlement({
      entitlementType: "egghead_legacy_pro_quarantine",
      sourceType: "a_quarantine",
    }),
    cohortEntitlement({
      entitlementType: "egghead_lifetime_access",
      sourceType: "z_lifetime",
      status: null,
      expiresAt: null,
    }),
    cohortEntitlement({ sourceType: "rails_account_subscription", status: "canceled" }),
  ],
  { now: cohortNow },
);
checks.push(
  assertEqual(
    "support names the actual granting source, not the first unrelated source",
    mixedReadback.explanation.summary,
    "Access granted by egghead_lifetime_access from z_lifetime.",
  ),
  assertNotIncludes(
    "support excludes terminal canceled source from effective reasoning",
    mixedReadback.sourceFamilies.allSourceTypes,
    "rails_account_subscription",
  ),
  assertEqual(
    "personal subscription requires actual owner",
    selectCurrentSubscriptionForUser([personalSubscription], [], cohortUserId, cohortNow)?.id ??
      "none",
    personalSubscription.id,
  ),
  assertEqual(
    "org-only member does not own another personal subscription",
    selectCurrentSubscriptionForUser(
      [personalSubscription],
      [],
      "synthetic-org-member",
      cohortNow,
    ) === null,
    true,
  ),
  assertEqual(
    "unseated team owner can still manage subscription",
    selectCurrentSubscriptionForUser([teamSubscription], [], "synthetic-owner", cohortNow)?.id ??
      "none",
    teamSubscription.id,
  ),
  assertEqual(
    "direct unexpired seat classifies member without org membership",
    selectCurrentSubscriptionForUser([teamSubscription], [memberSeat], cohortUserId, cohortNow)
      ?.id ?? "none",
    teamSubscription.id,
  ),
  assertEqual(
    "member classification does not fabricate ownership",
    selectCurrentSubscriptionForUser([teamSubscription], [memberSeat], cohortUserId, cohortNow)
      ?.fields.ownerId ?? "none",
    "synthetic-owner",
  ),
  assertEqual(
    "removed direct seat cannot classify member",
    selectCurrentSubscriptionForUser(
      [teamSubscription],
      [{ ...memberSeat, deletedAt: pastBoundary }],
      cohortUserId,
      cohortNow,
    ) === null,
    true,
  ),
  assertEqual(
    "expired direct seat cannot classify member",
    selectCurrentSubscriptionForUser(
      [teamSubscription],
      [{ ...memberSeat, expiresAt: pastBoundary }],
      cohortUserId,
      cohortNow,
    ) === null,
    true,
  ),
  assertEqual(
    "null-expiry direct seat cannot classify member",
    selectCurrentSubscriptionForUser(
      [teamSubscription],
      [{ ...memberSeat, expiresAt: null }],
      cohortUserId,
      cohortNow,
    ) === null,
    true,
  ),
  assertEqual(
    "terminal subscription cannot classify member",
    selectCurrentSubscriptionForUser(
      [{ ...teamSubscription, status: "canceled" }],
      [memberSeat],
      cohortUserId,
      cohortNow,
    ) === null,
    true,
  ),
);

for (const fields of [
  { isProContent: true },
  { is_pro_content: true },
  { freeAccess: false },
  { access: "pro" },
  { freeForever: false },
]) {
  checks.push(
    assertEqual(
      `known paid ${JSON.stringify(fields)} without parent remains gated`,
      lessonRequiresAccess(lessonAccessFromFields(fields, { hasParentCourseEvidence: false })),
      true,
    ),
  );
}
checks.push(
  assertEqual(
    "missing parent slug does not erase existing parent evidence",
    lessonRequiresAccess(lessonAccessFromFields({}, { hasParentCourseEvidence: true })),
    true,
  ),
  assertEqual(
    "intentionally standalone lesson without paid metadata remains ungated",
    lessonRequiresAccess(lessonAccessFromFields({}, { hasParentCourseEvidence: false })),
    false,
  ),
  assertEqual(
    "explicit free standalone lesson remains ungated",
    lessonRequiresAccess(
      lessonAccessFromFields(
        { isProContent: false, freeAccess: false },
        { hasParentCourseEvidence: false },
      ),
    ),
    false,
  ),
  assertEqual(
    "free lesson with unresolved parent remains ungated",
    lessonRequiresAccess(
      lessonAccessFromFields({ freeAccess: true }, { hasParentCourseEvidence: true }),
    ),
    false,
  ),
  assertEqual(
    "same-slug paid evidence survives missing parent",
    lessonRequiresAccess(
      lessonAccessFromFields({}, { hasParentCourseEvidence: false, freeForeverOverride: false }),
    ),
    true,
  ),
  assertEqual(
    "same-slug authoritative free marking wins",
    lessonRequiresAccess(
      lessonAccessFromFields(
        { freeAccess: false },
        { hasParentCourseEvidence: true, freeForeverOverride: true },
      ),
    ),
    false,
  ),
  assertEqual(
    "denied playback returns no media and performs no DB read",
    (await getLessonPlaybackForAccess("synthetic-denied-lesson", false)) === null,
    true,
  ),
);

const publicPaidLesson = lessonForPageFromRows({
  lesson: {
    id: "synthetic-public-lesson",
    fields: {
      title: "Synthetic paid lesson",
      slug: "synthetic-paid-lesson",
      isProContent: true,
      muxPlaybackId: "synthetic-private-playback",
      currentVideoHlsUrl: "https://media.example.invalid/synthetic-private-hls.m3u8",
      currentVideoDashUrl: "https://media.example.invalid/synthetic-private-dash.mpd",
      thumbnailUrl: "https://image.mux.com/synthetic-private-poster/thumbnail.webp",
    },
  },
  parentCourse: { id: "synthetic-missing-slug-course", fields: { title: "Synthetic course" } },
  videoResource: { id: "synthetic-private-video-resource", fields: {} },
  requestedSlug: "synthetic-paid-lesson",
  hasParentCourseEvidence: true,
});
const publicLessonPayload = JSON.stringify(publicPaidLesson);
for (const privateMarker of [
  "synthetic-private",
  "videoHlsUrl",
  "videoDashUrl",
  "videoPosterUrl",
  "videoMuxPlaybackId",
  "videoResourceId",
]) {
  checks.push(
    assertEqual(
      `public page/RSC/embed projection omits ${privateMarker}`,
      publicLessonPayload.includes(privateMarker),
      false,
    ),
  );
}
checks.push(
  assertEqual("public lesson retains only video availability", publicPaidLesson.hasVideo, true),
  assertEqual(
    "paid lesson with missing parent slug remains gated in actual page projection",
    lessonRequiresAccess(publicPaidLesson),
    true,
  ),
  assertEqual(
    "missing parent slug uses standalone route without downgrading access",
    publicPaidLesson.canonicalPath,
    "/synthetic-paid-lesson",
  ),
);

console.log(
  JSON.stringify({
    ok: true,
    checks,
    invariant: {
      canonicalCoursePages: "/:collectionSlug",
      canonicalCollectionLessons: "/:collectionSlug/:entrySlug",
      canonicalPodcastEpisodes: "/:podcastShowSlug/:episodeSlug",
      standaloneSingles: "/:slug",
      legacyUrlsPreserved: true,
      lessonStaticParamLimit: LESSON_STATIC_PARAM_LIMIT,
      lessonLevelFreeMarkingWinsOverCourseGating: true,
      knownPaidLessonsRemainGatedWithoutParentRouting: true,
      deniedLessonsNeverLoadPlaybackProjection: true,
    },
  }),
);
