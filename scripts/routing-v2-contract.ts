import { COURSE_LESSON_STATIC_PARAM_LIMIT } from "../apps/web/src/content/course";
import {
  ACCESS_ENTITLEMENT_ROWS_SQL,
  entitlementGrantsAccess,
  normalizeRequestCountry,
} from "../apps/web/src/access/evaluate";
import { lessonCanonicalPathForRouteContext } from "../apps/web/src/content/lesson-route-context";
import {
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
      onlyCourseLinkedLessonsMayGate: true,
    },
  }),
);
