import type { RowDataPacket } from "mysql2";
import { cacheLife, cacheTag } from "next/cache";

import { createLocalMysqlConnection } from "../db/local-docker";
import { doubleEncodedUtf8Variant } from "./encoding";
import { instructorUserIdsForName } from "./instructors";
import { parentCourseSlugsForLessonIds } from "./lesson-route-context";
import { publishedResourceSql } from "./publication";
import { contentResourceSlugSql } from "./resource-slug";
import {
  type SearchIndexDocument,
  searchDocumentFromResource,
  searchDocumentTypeFromResource,
  type SearchDocumentType,
} from "./search-document";
import {
  createEggheadTypesenseSearchClient,
  getEggheadTypesenseConfig,
  isEggheadTypesenseSearchConfigured,
} from "./typesense";

type SearchResourceRow = RowDataPacket & {
  createdAt: Date;
  id: string;
  type: string;
  updatedAt: Date;
  fields: unknown;
};

export type SearchResult = {
  id: string;
  type: SearchDocumentType;
  title: string;
  slug: string;
  description: string;
  href: string;
};

export type SearchContentType = SearchResult["type"];

export const SEARCH_CONTENT_TYPE_VALUES = [
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
] as const satisfies SearchContentType[];

function normalizedSearchContentType(typeFilter?: string | null) {
  const normalizedType = typeFilter?.trim() || null;
  if (!normalizedType) return null;
  return SEARCH_CONTENT_TYPE_VALUES.some((value) => value === normalizedType)
    ? normalizedType
    : "invalid";
}

async function searchRowsFromDatabase(
  term: string,
  typeFilter?: string | null,
  instructorFilter?: string | null,
  limit = 24,
) {
  const normalized = term.trim().toLowerCase();
  const likeTerm = `%${normalized}%`;
  const normalizedType = normalizedSearchContentType(typeFilter);
  if (normalizedType === "invalid") return [];
  const normalizedInstructor = instructorFilter?.trim() || null;
  // Display names are enriched from legacy instructor profiles, so filter by
  // the contributing user ids; fall back to stored names (both spellings —
  // some rows hold them double-encoded) when no ids resolve.
  const instructorUserIds = normalizedInstructor
    ? await instructorUserIdsForName(normalizedInstructor)
    : [];

  const connection = await createLocalMysqlConnection();
  const typeClause = normalizedType
    ? "AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')), resource.type) = ?"
    : "";
  const publicTypePlaceholders = SEARCH_CONTENT_TYPE_VALUES.map(() => "?").join(", ");
  const termClause = normalized
    ? `
            AND (
              LOWER(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.title'))) LIKE ?
              OR LOWER(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.description'))) LIKE ?
              OR LOWER(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.summary'))) LIKE ?
            )
        `
    : "";
  const instructorCandidates = instructorUserIds.length
    ? instructorUserIds
    : normalizedInstructor
      ? [...new Set([normalizedInstructor, doubleEncodedUtf8Variant(normalizedInstructor)])]
      : [];
  const instructorColumn = instructorUserIds.length ? "user.id" : "user.name";
  const instructorClause = instructorCandidates.length
    ? `
            AND EXISTS (
              SELECT 1
              FROM egghead_ContentContribution contribution
              JOIN egghead_User user ON user.id = contribution.userId
              WHERE contribution.contentId = resource.id
                AND ${instructorColumn} IN (${instructorCandidates.map(() => "?").join(", ")})
            )
        `
    : "";
  const params = [
    ...SEARCH_CONTENT_TYPE_VALUES,
    ...(normalizedType ? [normalizedType] : []),
    ...(normalized ? [likeTerm, likeTerm, likeTerm] : []),
    ...instructorCandidates,
  ];
  const limitClause = limit > 0 ? `LIMIT ${limit}` : "";

  try {
    const resourceSlugSql = await contentResourceSlugSql(connection, "resource");
    const [rows] = await connection.execute<SearchResourceRow[]>(
      `
          SELECT resource.id, resource.type, resource.fields, resource.createdAt, resource.updatedAt
          FROM egghead_ContentResource resource
          WHERE resource.deletedAt IS NULL
            ${publishedResourceSql("resource")}
            AND ${resourceSlugSql} IS NOT NULL
            AND ${resourceSlugSql} != ''
            AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')), resource.type) IN (${publicTypePlaceholders})
            ${typeClause}
            ${termClause}
            ${instructorClause}
          ORDER BY resource.createdAt DESC
          ${limitClause}
        `,
      params,
    );

    return rows;
  } finally {
    await connection.end();
  }
}

async function searchDocumentsFromRows(rows: SearchResourceRow[]) {
  const connection = await createLocalMysqlConnection();

  try {
    const parentCourseSlugs = await parentCourseSlugsForLessonIds(
      connection,
      rows.filter((row) => searchDocumentTypeFromResource(row) === "lesson").map((row) => row.id),
    );

    return rows.map((row) =>
      searchDocumentFromResource({
        parentCourseSlug: parentCourseSlugs.get(row.id),
        resource: row,
      }),
    );
  } finally {
    await connection.end();
  }
}

function searchResultFromDocument(document: SearchIndexDocument): SearchResult {
  return {
    id: document.id,
    type: document.type,
    title: document.title,
    slug: document.slug,
    description: document.description,
    href: document.path,
  };
}

async function searchSqlContent(
  term: string,
  typeFilter?: string | null,
  instructorFilter?: string | null,
) {
  const rows = await searchRowsFromDatabase(term, typeFilter, instructorFilter);
  const documents = await searchDocumentsFromRows(rows);
  return documents.map(searchResultFromDocument);
}

function typesenseFilter(typeFilter?: string | null) {
  const normalizedType = normalizedSearchContentType(typeFilter);
  if (!normalizedType) return undefined;
  if (normalizedType === "invalid") return "type:=__invalid__";
  return `type:=${normalizedType}`;
}

async function searchTypesenseContent(term: string, typeFilter?: string | null) {
  if (!isEggheadTypesenseSearchConfigured()) return null;

  const config = getEggheadTypesenseConfig();
  const client = createEggheadTypesenseSearchClient();
  const normalized = term.trim();
  const filter = typesenseFilter(typeFilter);
  const searchParams = {
    q: normalized || "*",
    query_by: "title,description,summary,body",
    per_page: 24,
    sort_by: normalized
      ? "_text_match:desc,updated_at_timestamp:desc"
      : "updated_at_timestamp:desc",
    ...(filter ? { filter_by: filter } : {}),
  };
  const response = await client
    .collections<SearchIndexDocument>(config.collectionName)
    .documents()
    .search(searchParams);

  return (response.hits ?? [])
    .map((hit) => hit.document)
    .filter(Boolean)
    .map(searchResultFromDocument);
}

export async function loadSearchIndexDocuments({
  limit,
}: {
  limit?: number;
} = {}) {
  const rows = await searchRowsFromDatabase("", null, null, limit ?? 0);
  const selectedRows = typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : rows;
  return searchDocumentsFromRows(selectedRows);
}

export async function searchContent(
  term: string,
  typeFilter?: string | null,
  instructorFilter?: string | null,
): Promise<SearchResult[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag("egghead-search");

  // The Typesense schema has no instructor field yet, so instructor-filtered
  // searches always run against SQL where contributions are joinable.
  if (!instructorFilter?.trim()) {
    try {
      const typesenseResults = await searchTypesenseContent(term, typeFilter);
      if (typesenseResults) return typesenseResults;
    } catch {
      return searchSqlContent(term, typeFilter, instructorFilter);
    }
  }

  return searchSqlContent(term, typeFilter, instructorFilter);
}
