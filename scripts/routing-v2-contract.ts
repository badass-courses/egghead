import { COURSE_LESSON_STATIC_PARAM_LIMIT } from "../apps/web/src/content/course";
import { lessonCanonicalPathForRouteContext } from "../apps/web/src/content/lesson-route-context";
import { lessonRequiresAccess } from "../apps/web/src/content/lesson-access";
import { LESSON_STATIC_PARAM_LIMIT } from "../apps/web/src/content/publication";
import {
  canonicalPodcastPath,
  canonicalPublicContentPath,
  collectionEntryPath,
  collectionPath,
  legacyCoursePath,
  legacyLessonEmbedPath,
  legacyLessonPath,
  legacyPublicContentPath,
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
  assertEqual(
    "tip canonical path is root slug",
    canonicalPublicContentPath("tip", "css-grid-tip"),
    "/css-grid-tip",
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
  assertNumberEqual(
    "course lesson static params use the shared lesson budget",
    COURSE_LESSON_STATIC_PARAM_LIMIT,
    LESSON_STATIC_PARAM_LIMIT,
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
      onlyCourseLinkedLessonsMayGate: true,
    },
  }),
);
