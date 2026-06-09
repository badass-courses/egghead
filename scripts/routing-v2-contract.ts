import { COURSE_LESSON_STATIC_PARAM_LIMIT } from "../apps/web/src/content/course";
import { lessonRequiresAccess } from "../apps/web/src/content/lesson-access";
import { LESSON_STATIC_PARAM_LIMIT } from "../apps/web/src/content/publication";
import {
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
      standaloneSingles: "/:slug",
      legacyUrlsPreserved: true,
      lessonStaticParamLimit: LESSON_STATIC_PARAM_LIMIT,
      onlyCourseLinkedLessonsMayGate: true,
    },
  }),
);
