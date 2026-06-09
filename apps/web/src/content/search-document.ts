import {
  booleanField,
  descriptionField,
  fieldsFromJson,
  markdownField,
  stringField,
} from "./fields";
import { lessonCanonicalPathForRouteContext } from "./lesson-route-context";
import {
  canonicalPublicContentPath,
  collectionPath,
  legacyCoursePath,
  legacyLessonEmbedPath,
  legacyLessonPath,
  legacyPublicContentPath,
  type PublicContentFamily,
} from "./routes";

export type SearchDocumentType =
  | "article"
  | "campaign"
  | "case-study"
  | "course"
  | "guide"
  | "lesson"
  | "podcast"
  | "post"
  | "project"
  | "success-story"
  | "talk"
  | "tip";

export type SearchDocumentParentResource = {
  path: string;
  slug: string;
  title: string;
  type: "course";
};

export type SearchIndexDocument = {
  body: string;
  canonicalPath: string;
  courseLinked: boolean;
  created_at_timestamp: number;
  description: string;
  freeForever: boolean;
  id: string;
  isProContent: boolean;
  legacyPaths: string[];
  parentResources: SearchDocumentParentResource[];
  path: string;
  slug: string;
  state: string;
  summary: string;
  title: string;
  type: SearchDocumentType;
  updated_at_timestamp: number;
  visibility: string;
};

export type ContentResourceForSearch = {
  createdAt?: Date | string | null;
  fields: unknown;
  id: string;
  type: string;
  updatedAt?: Date | string | null;
};

type SearchDocumentInput = {
  parentCourseSlug?: string | null | undefined;
  parentCourseTitle?: string | null | undefined;
  resource: ContentResourceForSearch;
};

type TypesenseFieldType = "bool" | "int64" | "object[]" | "string" | "string[]";

type TypesenseField = {
  facet?: boolean;
  name: string;
  optional?: boolean;
  sort?: boolean;
  type: TypesenseFieldType;
};

type TypesenseCollectionSchema = {
  default_sorting_field: string;
  enable_nested_fields?: boolean;
  fields: TypesenseField[];
  name: string;
};

export const EGGHEAD_TYPESENSE_COLLECTION_NAME = "egghead_content_migration_v1";

export const EGGHEAD_TYPESENSE_COLLECTION_SCHEMA: TypesenseCollectionSchema = {
  name: EGGHEAD_TYPESENSE_COLLECTION_NAME,
  enable_nested_fields: true,
  fields: [
    { name: "id", type: "string" },
    { name: "title", type: "string" },
    { name: "slug", type: "string", facet: true },
    { name: "type", type: "string", facet: true },
    { name: "path", type: "string", facet: true },
    { name: "canonicalPath", type: "string", facet: true },
    { name: "legacyPaths", type: "string[]", optional: true },
    { name: "description", type: "string", optional: true },
    { name: "summary", type: "string", optional: true },
    { name: "body", type: "string", optional: true },
    { name: "visibility", type: "string", facet: true },
    { name: "state", type: "string", facet: true },
    { name: "courseLinked", type: "bool", facet: true },
    { name: "isProContent", type: "bool", facet: true },
    { name: "freeForever", type: "bool", facet: true },
    { name: "parentResources", type: "object[]", optional: true },
    { name: "created_at_timestamp", type: "int64", sort: true },
    { name: "updated_at_timestamp", type: "int64", sort: true },
  ],
  default_sorting_field: "updated_at_timestamp",
};

const SEARCH_DOCUMENT_TYPES = new Set<string>([
  "article",
  "campaign",
  "case-study",
  "course",
  "guide",
  "lesson",
  "podcast",
  "post",
  "project",
  "success-story",
  "talk",
  "tip",
]);

export function isSearchDocumentType(value: string): value is SearchDocumentType {
  return SEARCH_DOCUMENT_TYPES.has(value);
}

export function searchDocumentType(type: string, postType: string | null): SearchDocumentType {
  if (type === "course" || postType === "course") return "course";
  if (type === "lesson" || postType === "lesson") return "lesson";
  if (postType && isSearchDocumentType(postType)) return postType;
  if (type === "post") return "post";
  return isSearchDocumentType(type) ? type : "post";
}

export function searchDocumentTypeFromResource(resource: ContentResourceForSearch) {
  const fields = fieldsFromJson(resource.fields);
  return searchDocumentType(resource.type, stringField(fields, "postType"));
}

export function canonicalPathForSearchDocument(
  type: SearchDocumentType,
  slug: string,
  parentCourseSlug?: string | null,
) {
  if (type === "course") return collectionPath(slug);
  if (type === "lesson") return lessonCanonicalPathForRouteContext(slug, parentCourseSlug);
  if (type !== "post") return canonicalPublicContentPath(type as PublicContentFamily, slug);
  return `/${slug}`;
}

export function legacyPathsForSearchDocument(type: SearchDocumentType, slug: string) {
  if (type === "course") return [legacyCoursePath(slug)];
  if (type === "lesson") return [legacyLessonPath(slug), legacyLessonEmbedPath(slug)];
  if (type !== "post") return [legacyPublicContentPath(type as PublicContentFamily, slug)];
  return [];
}

function timestampMs(value: Date | string | null | undefined) {
  if (value instanceof Date) return value.getTime();
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function uniqueLegacyPaths(paths: string[], canonicalPath: string) {
  return [...new Set(paths.filter((path) => path && path !== canonicalPath))];
}

export function searchDocumentFromResource(input: SearchDocumentInput): SearchIndexDocument {
  const fields = fieldsFromJson(input.resource.fields);
  const type = searchDocumentType(input.resource.type, stringField(fields, "postType"));
  const slug = stringField(fields, "slug") ?? input.resource.id;
  const path = canonicalPathForSearchDocument(type, slug, input.parentCourseSlug);
  const description = descriptionField(fields);
  const summary = stringField(fields, "summary") ?? stringField(fields, "description") ?? "";
  const body = markdownField(fields) ?? "";
  const parentResources =
    type === "lesson" && input.parentCourseSlug
      ? [
          {
            path: collectionPath(input.parentCourseSlug),
            slug: input.parentCourseSlug,
            title: input.parentCourseTitle ?? input.parentCourseSlug,
            type: "course" as const,
          },
        ]
      : [];

  return {
    body,
    canonicalPath: path,
    courseLinked: type === "lesson" && Boolean(input.parentCourseSlug),
    created_at_timestamp: timestampMs(input.resource.createdAt),
    description,
    freeForever: booleanField(fields, "freeForever"),
    id: input.resource.id,
    isProContent: booleanField(fields, "isProContent"),
    legacyPaths: uniqueLegacyPaths(legacyPathsForSearchDocument(type, slug), path),
    parentResources,
    path,
    slug,
    state: stringField(fields, "state") ?? "published",
    summary,
    title: stringField(fields, "title") ?? stringField(fields, "name") ?? "Untitled",
    type,
    updated_at_timestamp: timestampMs(input.resource.updatedAt),
    visibility:
      stringField(fields, "visibility") ?? stringField(fields, "visibilityState") ?? "public",
  };
}
