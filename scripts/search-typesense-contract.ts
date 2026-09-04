import { rejects } from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  EGGHEAD_TYPESENSE_COLLECTION_NAME,
  EGGHEAD_TYPESENSE_COLLECTION_SCHEMA,
  LEGACY_SEARCH_DOCUMENT_TYPES,
  canonicalPathForSearchDocument,
  legacyPathsForSearchDocument,
  searchDocumentFromResource,
  searchDocumentTypeFromResource,
} from "../apps/web/src/content/search-document";
import {
  doubleEncodedUtf8Variant,
  instructorMatchKey,
  normalizeInstructorDisplayName,
  repairDoubleEncodedUtf8,
} from "../apps/web/src/content/encoding";
import {
  SEARCH_CONTENT_TYPE_VALUES,
  legacyTypesenseSearchParameters,
  searchResultFromLegacyDocument,
  typesenseFilter,
  typesenseSearchParameters,
} from "../apps/web/src/content/search";
import {
  contentTypeFromSearchParams,
  searchTermFromRoute,
} from "../apps/web/src/content/search-route";
import {
  getEggheadTypesenseConfig,
  isEggheadTypesenseSearchConfigured,
  legacyTypesenseContentFilter,
} from "../apps/web/src/content/typesense";
import { legacyInstructorNamesForFilter } from "../apps/web/src/content/instructors";
import { GET as getInstructors } from "../apps/web/src/app/api/instructors/route";

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

function hasTypesenseDependency() {
  const packageJson: unknown = JSON.parse(readFileSync("apps/web/package.json", "utf8"));
  if (!packageJson || typeof packageJson !== "object") return false;
  const dependencies =
    "dependencies" in packageJson &&
    packageJson.dependencies &&
    typeof packageJson.dependencies === "object"
      ? packageJson.dependencies
      : {};
  const devDependencies =
    "devDependencies" in packageJson &&
    packageJson.devDependencies &&
    typeof packageJson.devDependencies === "object"
      ? packageJson.devDependencies
      : {};

  return "typesense" in dependencies || "typesense" in devDependencies;
}

function typesenseIndexScriptExists() {
  return existsSync(resolve("scripts/typesense-index.ts"));
}

function assertIncludes(name: string, values: readonly string[], expected: string) {
  if (!values.includes(expected)) {
    throw new Error(`${name}: expected ${expected} in ${JSON.stringify(values)}`);
  }

  return { name, pass: true as const };
}

function assertNotIncludes(name: string, values: readonly string[], blocked: string) {
  if (values.includes(blocked)) {
    throw new Error(`${name}: did not expect ${blocked} in ${JSON.stringify(values)}`);
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

function assertFacetField(name: string, expected: string) {
  const field = EGGHEAD_TYPESENSE_COLLECTION_SCHEMA.fields.find(
    (candidate) => candidate.name === expected,
  );

  if (!field || field.facet !== true) {
    throw new Error(`${name}: schema field ${expected} is not faceted`);
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
  instructorNames: ["John  Lindquist", "Joel Hooks", "John Lindquist"],
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

const podcastEpisode = searchDocumentFromResource({
  resource: {
    createdAt: "2026-01-05T00:00:00.000Z",
    fields: {
      contentResourceKind: "podcast-episode",
      podcastShowSlug: "developer-chats",
      postType: "podcast",
      slug: "alex-reardon-on-balancing-work-life-and-large-side-projects",
      title: "Alex Reardon on Balancing Work, Life, and Large Side Projects",
    },
    id: "podcast_alex_reardon",
    type: "post",
    updatedAt: "2026-01-06T00:00:00.000Z",
  },
});

const legacyCourse = {
  id: "playlist_123",
  instructor_name: "John Lindquist",
  path: "/playlists/script-kit-showcase",
  published_at_timestamp: 0,
  slug: "script-kit-showcase",
  summary: "Automate everyday workflows.",
  title: "Script Kit Showcase",
  type: "playlist",
};

// A local HTTP fixture exercises the SDK and the real API handler, not a live
// Typesense deployment. All requests and environment changes stay in-process.
async function instructorApiChecks() {
  const environmentKeys = [
    "TYPESENSE_COLLECTION_NAME",
    "NEXT_PUBLIC_TYPESENSE_COLLECTION_NAME",
    "NEXT_PUBLIC_TYPESENSE_HOST",
    "NEXT_PUBLIC_TYPESENSE_HOST_HASH",
    "NEXT_PUBLIC_TYPESENSE_PORT",
    "NEXT_PUBLIC_TYPESENSE_PROTOCOL",
    "NEXT_PUBLIC_TYPESENSE_API_KEY",
  ] as const;
  const previousEnvironment = environmentKeys.map((key) => [key, process.env[key]] as const);
  const requests: URL[] = [];
  let fail = false;
  const server = createServer((request, response) => {
    requests.push(new URL(request.url ?? "/", "http://localhost"));
    response.setHeader("content-type", "application/json");
    if (fail) {
      response.writeHead(400);
      response.end(JSON.stringify({ message: "fixture missing instructor_name facet" }));
      return;
    }
    response.end(
      JSON.stringify({
        hits: [],
        found: 0,
        facet_counts: [
          {
            field_name: "instructor_name",
            counts: [
              { value: "John Lindquist", count: 200 },
              { value: "Matías Hernández", count: 80 },
              { value: "MatÃ­as HernÃ¡ndez", count: 20 },
              ...Array.from({ length: 10 }, (_, index) => ({
                value: `Instructor ${index}`,
                count: 10 - index,
              })),
              { value: "   ", count: 999 },
            ],
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
  try {
    for (const key of environmentKeys) delete process.env[key];
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server has no TCP port.");
    const fixtureChecks = [
      assertEqual(
        "unconfigured search retains SQL selection",
        isEggheadTypesenseSearchConfigured(),
        false,
      ),
      assertEqual(
        "default read schema remains canonical",
        getEggheadTypesenseConfig().searchSchema,
        "canonical",
      ),
      assertEqual(
        "runtime config defaults to migration collection",
        getEggheadTypesenseConfig().collectionName,
        EGGHEAD_TYPESENSE_COLLECTION_NAME,
      ),
    ];
    process.env["NEXT_PUBLIC_TYPESENSE_COLLECTION_NAME"] = "content_production";
    fixtureChecks.push(
      assertEqual(
        "public collection setting selects legacy reads",
        getEggheadTypesenseConfig().searchSchema,
        "legacy",
      ),
    );
    process.env["TYPESENSE_COLLECTION_NAME"] = EGGHEAD_TYPESENSE_COLLECTION_NAME;
    fixtureChecks.push(
      assertEqual(
        "server collection setting takes precedence",
        getEggheadTypesenseConfig().searchSchema,
        "canonical",
      ),
    );
    process.env["TYPESENSE_COLLECTION_NAME"] = "content_production";
    process.env["NEXT_PUBLIC_TYPESENSE_HOST"] = "127.0.0.1";
    process.env["NEXT_PUBLIC_TYPESENSE_PORT"] = String(address.port);
    process.env["NEXT_PUBLIC_TYPESENSE_PROTOCOL"] = "http";
    process.env["NEXT_PUBLIC_TYPESENSE_API_KEY"] = "local-contract-fixture";

    const defaults: unknown = await (
      await getInstructors(new Request("http://localhost/api/instructors"))
    ).json();
    const byName: unknown = await (
      await getInstructors(new Request("http://localhost/api/instructors?q=matias"))
    ).json();
    const bounded: unknown = await (
      await getInstructors(new Request("http://localhost/api/instructors?q=instructor"))
    ).json();
    const missing: unknown = await (
      await getInstructors(new Request("http://localhost/api/instructors?q=not-a-name"))
    ).json();
    const indexedNames = await legacyInstructorNamesForFilter(" MATIAS  HERNANDEZ ");
    fixtureChecks.push(
      assertEqual(
        "default API suggestions are normalized ranked and bounded",
        JSON.stringify(defaults),
        JSON.stringify({
          instructors: [
            { name: "John Lindquist", resourceCount: 200 },
            { name: "Matías Hernández", resourceCount: 100 },
            ...Array.from({ length: 4 }, (_, index) => ({
              name: `Instructor ${index}`,
              resourceCount: 10 - index,
            })),
          ],
        }),
      ),
      assertEqual(
        "API name search folds accents and merges encoding variants",
        JSON.stringify(byName),
        JSON.stringify({ instructors: [{ name: "Matías Hernández", resourceCount: 100 }] }),
      ),
      assertEqual(
        "typed API suggestions stay bounded",
        JSON.stringify(bounded),
        JSON.stringify({
          instructors: Array.from({ length: 8 }, (_, index) => ({
            name: `Instructor ${index}`,
            resourceCount: 10 - index,
          })),
        }),
      ),
      assertEqual(
        "unknown instructor does not return unfiltered suggestions",
        JSON.stringify(missing),
        JSON.stringify({ instructors: [] }),
      ),
      assertEqual(
        "normalized selection resolves exact indexed spellings",
        indexedNames.join("|"),
        "Matías Hernández|MatÃ­as HernÃ¡ndez",
      ),
      assertEqual(
        "resolved spellings become a single exact OR filter",
        legacyTypesenseSearchParameters("", "course", indexedNames).filter_by,
        "type:=playlist && instructor_name:=[`Matías Hernández`,`MatÃ­as HernÃ¡ndez`]",
      ),
      assertEqual(
        "API reads configured catalog",
        requests.every(
          (request) => request.pathname === "/collections/content_production/documents/search",
        ),
        true,
      ),
      assertEqual(
        "instructor facets share supported search scope",
        requests.every(
          (request) =>
            request.searchParams.get("filter_by") === legacyTypesenseSearchParameters("").filter_by,
        ),
        true,
      ),
      assertEqual(
        "API facets the existing instructor field",
        requests.every((request) => request.searchParams.get("facet_by") === "instructor_name"),
        true,
      ),
    );
    fail = true;
    await rejects(
      () => getInstructors(new Request("http://localhost/api/instructors")),
      /fixture missing instructor_name facet/,
    );
    fixtureChecks.push({
      name: "legacy API surfaces index failures rather than SQL fallback",
      pass: true,
    });
    return fixtureChecks;
  } finally {
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolveClosed, rejectClose) => {
      server.close((error) => {
        if (error) {
          rejectClose(error);
          return;
        }
        resolveClosed();
      });
    });
  }
}

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
  assertNotIncludes(
    "search content types exclude retired guides",
    SEARCH_CONTENT_TYPE_VALUES,
    "guide",
  ),
  assertNotIncludes(
    "search content types exclude retired projects",
    SEARCH_CONTENT_TYPE_VALUES,
    "project",
  ),
  assertNotIncludes(
    "search content types exclude migrated tips",
    SEARCH_CONTENT_TYPE_VALUES,
    "tip",
  ),
  assertField("schema exposes canonical result path", "path"),
  assertField("schema exposes canonicalPath alias", "canonicalPath"),
  assertField("schema exposes legacy paths", "legacyPaths"),
  assertField("schema exposes parent resources", "parentResources"),
  assertEqual(
    "schema enables nested fields for parent resources",
    EGGHEAD_TYPESENSE_COLLECTION_SCHEMA.enable_nested_fields === true,
    true,
  ),
  assertField("schema exposes course linkage", "courseLinked"),
  assertFacetField("schema facets instructor display names", "instructorNames"),
  assertFacetField("schema facets normalized instructor keys", "instructorKeys"),
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
    "search document preserves multiple normalized contributors",
    courseLinkedLesson.instructorNames.join(","),
    "John Lindquist,Joel Hooks",
  ),
  assertEqual(
    "search document indexes normalized contributor keys",
    courseLinkedLesson.instructorKeys.join(","),
    "johnlindquist,joelhooks",
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
    "podcast episode path uses show child route",
    podcastEpisode.path,
    "/developer-chats/alex-reardon-on-balancing-work-life-and-large-side-projects",
  ),
  assertIncludes(
    "podcast episode preserves legacy podcast path as metadata",
    podcastEpisode.legacyPaths,
    "/podcasts/alex-reardon-on-balancing-work-life-and-large-side-projects",
  ),
  assertEqual("typesense dependency is declared", hasTypesenseDependency(), true),
  assertEqual("guarded typesense index script exists", typesenseIndexScriptExists(), true),
  assertEqual(
    "path segment search decodes percent spaces",
    searchTermFromRoute({
      params: { all: ["react%20beautiful%20dnd"] },
      searchParams: {},
    }),
    "react beautiful dnd",
  ),
  assertEqual(
    "path segment search joins slash split terms",
    searchTermFromRoute({
      params: { all: ["react", "beautiful", "dnd"] },
      searchParams: {},
    }),
    "react beautiful dnd",
  ),
  assertEqual(
    "path segment search treats plus as a space",
    searchTermFromRoute({
      params: { all: ["react+beautiful+dnd"] },
      searchParams: {},
    }),
    "react beautiful dnd",
  ),
  assertEqual(
    "double-encoded instructor names are repaired",
    repairDoubleEncodedUtf8("MatÃ­as HernÃ¡ndez"),
    "Matías Hernández",
  ),
  assertEqual(
    "cp1252-flavored instructor names are repaired",
    repairDoubleEncodedUtf8(doubleEncodedUtf8Variant("Ákos Kőműves")),
    "Ákos Kőműves",
  ),
  assertEqual(
    "mixed non-Latin and mojibake instructor names are repaired safely",
    repairDoubleEncodedUtf8("Łukasz HernÃ¡ndez"),
    "Łukasz Hernández",
  ),
  assertEqual(
    "mixed CJK and mojibake instructor names are repaired safely",
    repairDoubleEncodedUtf8("MatÃ­as 李"),
    "Matías 李",
  ),
  assertEqual(
    "clean Unicode instructor names remain unchanged",
    repairDoubleEncodedUtf8("Łukasz Hernández 李 🥚"),
    "Łukasz Hernández 李 🥚",
  ),
  assertEqual(
    "instructor display names normalize whitespace and mojibake",
    normalizeInstructorDisplayName("  Łukasz   HernÃ¡ndez "),
    "Łukasz Hernández",
  ),
  assertEqual(
    "instructor filter keys fold case accents and spacing",
    instructorMatchKey(" Jöhn  Líndquist "),
    "johnlindquist",
  ),
  assertEqual(
    "Typesense query searches instructor display names",
    typesenseSearchParameters("John Lindquist").query_by,
    "title,description,summary,body,instructorNames",
  ),
  assertEqual(
    "Typesense combines type and normalized instructor filters",
    typesenseFilter(" lesson ", " Jöhn  Líndquist "),
    "type:=lesson && instructorKeys:=`johnlindquist`",
  ),
  assertEqual(
    "Typesense supports instructor filtering without a text query",
    typesenseSearchParameters("", null, "John Lindquist").filter_by,
    `type:=[${SEARCH_CONTENT_TYPE_VALUES.join(", ")}] && instructorKeys:=\`johnlindquist\``,
  ),
  assertEqual(
    "legacy instructor course browsing uses the existing playlist field",
    legacyTypesenseSearchParameters("", " course ", ["John Lindquist"]).filter_by,
    "type:=playlist && instructor_name:=`John Lindquist`",
  ),
  assertEqual("legacy browse query uses wildcard", legacyTypesenseSearchParameters("").q, "*"),
  assertEqual(
    "legacy query retains title and instructor relevance",
    legacyTypesenseSearchParameters(" John ").query_by,
    "title,description,summary,instructor_name",
  ),
  assertEqual(
    "legacy text search sorts relevance before recency",
    legacyTypesenseSearchParameters("react").sort_by,
    "_text_match:desc,updated_at_timestamp:desc",
  ),
  assertEqual(
    "legacy browsing sorts by existing timestamp",
    legacyTypesenseSearchParameters("").sort_by,
    "updated_at_timestamp:desc",
  ),
  assertEqual(
    "legacy unsupported type cannot broaden a search",
    legacyTypesenseSearchParameters("", "guide").filter_by,
    "type:=__invalid__",
  ),
  assertEqual(
    "legacy catalog scope maps every supported app type",
    LEGACY_SEARCH_DOCUMENT_TYPES.toSorted().join(","),
    SEARCH_CONTENT_TYPE_VALUES.map((type) => (type === "course" ? "playlist" : type))
      .toSorted()
      .join(","),
  ),
  assertEqual(
    "legacy facets do not infer publication from missing timestamps",
    legacyTypesenseContentFilter("course"),
    "type:=playlist",
  ),
  assertEqual(
    "legacy playlists render as courses",
    searchResultFromLegacyDocument(legacyCourse)?.type ?? "",
    "course",
  ),
  assertEqual(
    "legacy IDs remain stable",
    searchResultFromLegacyDocument(legacyCourse)?.id ?? "",
    "playlist_123",
  ),
  assertEqual(
    "legacy playlist paths become app course paths",
    searchResultFromLegacyDocument(legacyCourse)?.href ?? "",
    "/script-kit-showcase",
  ),
  assertEqual(
    "legacy summary supplies missing description",
    searchResultFromLegacyDocument(legacyCourse)?.description ?? "",
    "Automate everyday workflows.",
  ),
  assertEqual(
    "published legacy courses with zero timestamps remain readable",
    searchResultFromLegacyDocument(legacyCourse) !== null,
    true,
  ),
  assertEqual(
    "modern legacy-catalog IDs are not rewritten",
    searchResultFromLegacyDocument({ ...legacyCourse, id: "1378983" })?.id ?? "",
    "1378983",
  ),
  assertEqual(
    "modern nested paths in legacy catalog are preserved",
    searchResultFromLegacyDocument({
      ...legacyCourse,
      type: "lesson",
      path: "/modern-course/modern-lesson",
    })?.href ?? "",
    "/modern-course/modern-lesson",
  ),
  assertEqual(
    "legacy lesson aliases become app paths",
    searchResultFromLegacyDocument({
      ...legacyCourse,
      type: "lesson",
      path: "/lessons/script-kit-showcase",
    })?.href ?? "",
    "/script-kit-showcase",
  ),
  assertEqual(
    "unsupported legacy hits are not reclassified as posts",
    searchResultFromLegacyDocument({ ...legacyCourse, type: "guide" }) === null,
    true,
  ),
  assertEqual(
    "path segment search treats encoded plus as a space",
    searchTermFromRoute({
      params: { all: ["react%2Bbeautiful%2Bdnd"] },
      searchParams: {},
    }),
    "react beautiful dnd",
  ),
  assertEqual(
    "query param search term takes precedence",
    searchTermFromRoute({
      params: { all: ["ignored"] },
      searchParams: { q: "react beautiful dnd" },
    }),
    "react beautiful dnd",
  ),
  assertEqual(
    "search type is trimmed",
    contentTypeFromSearchParams({ type: " podcast " }),
    "podcast",
  ),
];

checks.push(...(await instructorApiChecks()));

console.log(
  JSON.stringify({
    ok: true,
    checks,
    invariant: {
      collectionName: EGGHEAD_TYPESENSE_COLLECTION_NAME,
      indexedResultUrlField: "path",
      indexedInstructorFields: ["instructorNames", "instructorKeys"],
      legacyCollectionName: "content_production",
      legacyInstructorField: "instructor_name",
      legacyReadsRequireNoReindex: true,
      instructorApiFixtureOnly: true,
      legacyInstructorDiscoveryUsesIndexedFacets: true,
      canonicalInstructorFieldsRequireSchemaAndIndexData: true,
      podcastEpisodeUrlShape: "/:podcastShowSlug/:episodeSlug",
      legacyUrlsPreservedAsMetadata: true,
      liveTypesenseDependencyAdded: hasTypesenseDependency(),
      guardedTypesenseIndexScriptAdded: typesenseIndexScriptExists(),
      externalProvisioningValidatedByContract: false,
      liveTypesenseCollectionProvisioned: false,
      liveTypesenseIndexingEnabled: false,
    },
  }),
);
