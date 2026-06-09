import {
  EGGHEAD_TYPESENSE_COLLECTION_NAME,
  EGGHEAD_TYPESENSE_COLLECTION_SCHEMA,
  canonicalPathForSearchDocument,
  legacyPathsForSearchDocument,
  searchDocumentFromResource,
  searchDocumentTypeFromResource,
} from "../apps/web/src/content/search-document";
import { getEggheadTypesenseConfig } from "../apps/web/src/content/typesense";

function assertEqual(
  name: string,
  actual: string | boolean | number,
  expected: string | boolean | number,
) {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${String(expected)}, got ${String(actual)}`);
  }

  return { name, pass: true as const };
}

function assertIncludes(name: string, values: readonly string[], expected: string) {
  if (!values.includes(expected)) {
    throw new Error(`${name}: expected ${expected} in ${JSON.stringify(values)}`);
  }

  return { name, pass: true as const };
}

function assertField(name: string, expected: string) {
  const fieldNames = new Set(EGGHEAD_TYPESENSE_COLLECTION_SCHEMA.fields.map((field) => field.name));

  if (!fieldNames.has(expected)) {
    throw new Error(`${name}: missing schema field ${expected}`);
  }

  return { name, pass: true as const };
}

const courseLinkedLessonResource = {
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  fields: {
    body: "Use the renderer and camera to draw a scene.",
    freeForever: false,
    isProContent: true,
    postType: "lesson",
    slug: "camera-and-renderer",
    title: "Camera and Renderer",
    visibility: "public",
  },
  id: "lesson_camera_renderer",
  type: "post",
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
};

const courseLinkedLesson = searchDocumentFromResource({
  parentCourseSlug: "modern-three-js",
  parentCourseTitle: "Modern Three.js",
  resource: courseLinkedLessonResource,
});

const standaloneLesson = searchDocumentFromResource({
  resource: {
    createdAt: "2026-01-03T00:00:00.000Z",
    fields: {
      description: "Use React.PureComponent to skip extra renders.",
      postType: "lesson",
      slug: "react-purecomponent-in-react",
      title: "React PureComponent in React",
    },
    id: "lesson_react_purecomponent",
    type: "post",
    updatedAt: "2026-01-04T00:00:00.000Z",
  },
});

const checks = [
  assertEqual(
    "typesense collection name is migration scoped",
    EGGHEAD_TYPESENSE_COLLECTION_NAME,
    "egghead_content_migration_v1",
  ),
  assertEqual(
    "course canonical path is root collection path",
    canonicalPathForSearchDocument("course", "modern-three-js"),
    "/modern-three-js",
  ),
  assertEqual(
    "course lesson canonical path is collection child",
    canonicalPathForSearchDocument("lesson", "camera-and-renderer", "modern-three-js"),
    "/modern-three-js/camera-and-renderer",
  ),
  assertEqual(
    "standalone lesson canonical path is root single",
    canonicalPathForSearchDocument("lesson", "react-purecomponent-in-react", null),
    "/react-purecomponent-in-react",
  ),
  assertIncludes(
    "legacy lesson path is indexable metadata",
    legacyPathsForSearchDocument("lesson", "camera-and-renderer"),
    "/lessons/camera-and-renderer",
  ),
  assertIncludes(
    "legacy embed path is indexable metadata",
    legacyPathsForSearchDocument("lesson", "camera-and-renderer"),
    "/lessons/camera-and-renderer/embed",
  ),
  assertIncludes(
    "legacy article path is indexable metadata",
    legacyPathsForSearchDocument("article", "some-post"),
    "/blog/some-post",
  ),
  assertField("schema exposes canonical result path", "path"),
  assertField("schema exposes canonicalPath alias", "canonicalPath"),
  assertField("schema exposes legacy paths", "legacyPaths"),
  assertField("schema exposes parent resources", "parentResources"),
  assertField("schema exposes course linkage", "courseLinked"),
  assertEqual(
    "postType lesson resources classify as lessons",
    searchDocumentTypeFromResource(courseLinkedLessonResource),
    "lesson",
  ),
  assertEqual(
    "course-linked lesson path uses collection child",
    courseLinkedLesson.path,
    "/modern-three-js/camera-and-renderer",
  ),
  assertEqual("course-linked lesson marks courseLinked", courseLinkedLesson.courseLinked, true),
  assertEqual(
    "course-linked lesson preserves parent count",
    courseLinkedLesson.parentResources.length,
    1,
  ),
  assertEqual(
    "course-linked lesson parent path is course path",
    courseLinkedLesson.parentResources[0]?.path ?? "",
    "/modern-three-js",
  ),
  assertEqual(
    "standalone lesson path uses root single",
    standaloneLesson.path,
    "/react-purecomponent-in-react",
  ),
  assertEqual("standalone lesson is not course linked", standaloneLesson.courseLinked, false),
  assertEqual(
    "standalone lesson has no parent resources",
    standaloneLesson.parentResources.length,
    0,
  ),
  assertEqual(
    "runtime config defaults to migration collection",
    getEggheadTypesenseConfig().collectionName,
    EGGHEAD_TYPESENSE_COLLECTION_NAME,
  ),
];

console.log(
  JSON.stringify({
    ok: true,
    checks,
    invariant: {
      collectionName: EGGHEAD_TYPESENSE_COLLECTION_NAME,
      indexedResultUrlField: "path",
      legacyUrlsPreservedAsMetadata: true,
      liveTypesenseDependencyAdded: true,
      guardedTypesenseIndexScriptAdded: true,
      liveTypesenseCollectionProvisioned: false,
      liveTypesenseIndexingEnabled: false,
    },
  }),
);
