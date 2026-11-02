import {
  SEARCH_PAGE_SIZE,
  decodeSearchCursor,
  encodeSearchCursor,
  searchScope,
  type SearchCursor,
  type SqlSearchCursor,
  type SearchPage,
  searchPage,
} from "./search-pagination";

import type { RowDataPacket } from "mysql2";
import { cacheLife, cacheTag } from "next/cache";

import { createLocalMysqlConnection } from "../db/local-docker";
import { doubleEncodedUtf8Variant, instructorMatchKey } from "./encoding";
import {
  instructorNamesByContentId,
  instructorUserIdsForName,
  legacyInstructorNamesForFilter,
} from "./instructors";
import { parentCourseSlugsForLessonIds } from "./lesson-route-context";
import { publishedResourceSql } from "./publication";
import { contentResourceSlugSql } from "./resource-slug";
import {
  type LegacySearchIndexDocument,
  legacySearchDocumentType,
  pathForLegacySearchDocument,
  type SearchIndexDocument,
  searchDocumentFromResource,
  searchDocumentTypeFromResource,
  type SearchDocumentType,
} from "./search-document";
import {
  createEggheadTypesenseSearchClient,
  getEggheadTypesenseConfig,
  isEggheadTypesenseSearchConfigured,
  legacyTypesenseContentFilter,
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

export type SearchQuery = {
  term: string;
  contentType?: string | null;
  instructor?: string | null;
};

type PreparedSqlFilter = { where: string; params: string[] };

export const SEARCH_CONTENT_TYPE_VALUES = [
  "article",
  "campaign",
  "case-study",
  "course",
  "lesson",
  "podcast",
  "post",
  "success-story",
  "talk",
] as const satisfies SearchContentType[];

function normalizedSearchContentType(typeFilter?: string | null) {
  const normalizedType = typeFilter?.trim() || null;
  if (!normalizedType) return null;
  return SEARCH_CONTENT_TYPE_VALUES.some((value) => value === normalizedType)
    ? normalizedType
    : "invalid";
}

async function searchableResourceSql(
  connection: Awaited<ReturnType<typeof createLocalMysqlConnection>>,
) {
  const slug = await contentResourceSlugSql(connection, "resource");
  return `resource.deletedAt IS NULL
    ${publishedResourceSql("resource")}
    AND ${slug} IS NOT NULL AND ${slug} != ''
    AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')), resource.type)
      IN (${SEARCH_CONTENT_TYPE_VALUES.map((type) => `'${type}'`).join(", ")})`;
}

// Resolve identities and eligibility once, then share the prepared predicate between reads.
async function searchFilterSql(
  connection: Awaited<ReturnType<typeof createLocalMysqlConnection>>,
  term: string,
  typeFilter?: string | null,
  instructorFilter?: string | null,
) {
  const normalized = term.trim().toLowerCase();
  const likeTerm = `%${normalized}%`;
  const normalizedType = normalizedSearchContentType(typeFilter);
  if (normalizedType === "invalid") return null;
  const normalizedInstructor = instructorFilter?.trim() || null;
  // Display names are enriched from legacy instructor profiles, so filter by
  // the contributing user ids; fall back to stored names (both spellings —
  // some rows hold them double-encoded) when no ids resolve.
  const instructorUserIds = normalizedInstructor
    ? await instructorUserIdsForName(normalizedInstructor)
    : [];

  const typeClause = normalizedType
    ? "AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')), resource.type) = ?"
    : "";
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
  const eligible = await searchableResourceSql(connection);
  return {
    where: `${eligible}
            ${typeClause}
            ${termClause}
            ${instructorClause}`,
    params: [
      ...(normalizedType ? [normalizedType] : []),
      ...(normalized ? [likeTerm, likeTerm, likeTerm] : []),
      ...instructorCandidates,
    ],
  };
}

async function prepareSearchFilter(query: SearchQuery) {
  const connection = await createLocalMysqlConnection();
  try {
    return await searchFilterSql(connection, query.term, query.contentType, query.instructor);
  } finally {
    await connection.end();
  }
}

async function searchRowsFromDatabase(
  filter: PreparedSqlFilter,
  limit = SEARCH_PAGE_SIZE,
  cursor?: SqlSearchCursor | null,
) {
  const connection = await createLocalMysqlConnection();
  const boundary = cursor?.boundary;
  const backwards = cursor?.direction === "previous" && Boolean(boundary);
  const comparison = backwards ? ">" : "<";
  const cursorClause = boundary
    ? `AND (resource.createdAt ${comparison} ? OR (resource.createdAt = ? AND resource.id ${comparison} ?))`
    : "";
  const limitClause = limit > 0 ? `LIMIT ${limit}` : "";

  try {
    const [rows] = await connection.execute<SearchResourceRow[]>(
      `
          SELECT resource.id, resource.type, resource.fields, resource.createdAt, resource.updatedAt
          FROM egghead_ContentResource resource
          WHERE ${filter.where}
            ${cursorClause}
          ORDER BY resource.createdAt ${backwards ? "ASC" : "DESC"}, resource.id ${backwards ? "ASC" : "DESC"}
          ${limitClause}
        `,
      [
        ...filter.params,
        ...(boundary
          ? [new Date(boundary.createdAt), new Date(boundary.createdAt), boundary.id]
          : []),
      ],
    );

    return rows;
  } finally {
    await connection.end();
  }
}

// The total is a full scan, so it is cached per search and shared by every page.
async function searchTotalFromDatabase(filter: PreparedSqlFilter) {
  "use cache";
  cacheLife("minutes");
  cacheTag("egghead-search");

  const connection = await createLocalMysqlConnection();
  try {
    const [[count]] = await connection.execute<(RowDataPacket & { total: number | string })[]>(
      `SELECT COUNT(*) AS total FROM egghead_ContentResource resource WHERE ${filter.where}`,
      filter.params,
    );
    return Number(count?.total ?? 0);
  } finally {
    await connection.end();
  }
}

async function searchDocumentsFromRows(rows: SearchResourceRow[]) {
  const connection = await createLocalMysqlConnection();

  try {
    const [parentCourseSlugs, instructorNames] = await Promise.all([
      parentCourseSlugsForLessonIds(
        connection,
        rows.filter((row) => searchDocumentTypeFromResource(row) === "lesson").map((row) => row.id),
      ),
      instructorNamesByContentId(rows.map((row) => row.id)),
    ]);

    return rows.map((row) =>
      searchDocumentFromResource({
        instructorNames: instructorNames.get(row.id),
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

export function searchResultFromLegacyDocument(
  document: LegacySearchIndexDocument,
): SearchResult | null {
  const type = legacySearchDocumentType(document.type);
  const href = pathForLegacySearchDocument(document);
  if (!type || !href) return null;
  return {
    id: document.id,
    type,
    title: document.title,
    slug: document.slug,
    description: document.description || document.summary || "",
    href,
  };
}

export type SearchResultsPage = SearchPage<SearchResult>;

async function searchSqlContent(
  term: string,
  typeFilter?: string | null,
  instructorFilter?: string | null,
  cursor?: SearchCursor | null,
): Promise<SearchResultsPage> {
  // A Typesense page cannot serve as a SQL boundary after a reader failure.
  const sqlCursor = cursor?.source === "sql" ? cursor : null;
  const page = sqlCursor?.page ?? 1;
  const filter = await prepareSearchFilter({
    term,
    contentType: typeFilter ?? null,
    instructor: instructorFilter ?? null,
  });
  const scope = searchScope(term, typeFilter, instructorFilter);
  if (!filter)
    return searchPage({ results: [], page, total: 0, previousCursor: null, nextCursor: null });
  // Only the two reads run in parallel; both use the same resolved identities and predicate.
  const [rows, counted] = await Promise.all([
    searchRowsFromDatabase(filter, SEARCH_PAGE_SIZE + 1, sqlCursor),
    searchTotalFromDatabase(filter),
  ]);
  const hasMore = rows.length > SEARCH_PAGE_SIZE;
  const selected = rows.slice(0, SEARCH_PAGE_SIZE);
  const backwards = sqlCursor?.direction === "previous" && Boolean(sqlCursor.boundary);
  if (backwards) selected.reverse();
  const documents = await searchDocumentsFromRows(selected);
  const first = selected[0];
  const last = selected.at(-1);
  const previousCursor =
    page > 1 && first && (!backwards || hasMore)
      ? encodeSearchCursor({
          page: page - 1,
          source: "sql",
          scope,
          direction: "previous",
          ...(page > 2
            ? { boundary: { id: first.id, createdAt: first.createdAt.toISOString() } }
            : {}),
        })
      : null;
  const nextCursor =
    last && (backwards || hasMore) && page < 10_000
      ? encodeSearchCursor({
          page: page + 1,
          source: "sql",
          scope,
          direction: "next",
          boundary: { id: last.id, createdAt: last.createdAt.toISOString() },
        })
      : null;
  // A short first page is the whole match set, even if the cached count is stale.
  const total = page === 1 && !hasMore ? selected.length : counted;
  return searchPage({
    results: documents.map(searchResultFromDocument),
    page,
    total,
    previousCursor,
    nextCursor,
  });
}

function typesenseResultsPage(
  results: SearchResult[],
  found: number,
  page: number,
  scope: string,
): SearchResultsPage {
  return searchPage({
    results,
    page,
    total: found,
    previousCursor:
      page > 1 ? encodeSearchCursor({ page: page - 1, source: "typesense", scope }) : null,
    nextCursor:
      page * SEARCH_PAGE_SIZE < found && page < 10_000
        ? encodeSearchCursor({ page: page + 1, source: "typesense", scope })
        : null,
  });
}

function typesenseFilterValue(value: string) {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

export function typesenseFilter(typeFilter?: string | null, instructorFilter?: string | null) {
  const normalizedType = normalizedSearchContentType(typeFilter);
  const filters = [
    normalizedType === "invalid"
      ? "type:=__invalid__"
      : normalizedType
        ? `type:=${normalizedType}`
        : `type:=[${SEARCH_CONTENT_TYPE_VALUES.join(", ")}]`,
  ];
  const instructorKey = instructorMatchKey(instructorFilter ?? "");
  if (instructorKey) {
    filters.push(`instructorKeys:=${typesenseFilterValue(instructorKey)}`);
  }
  return filters.join(" && ");
}

export function typesenseSearchParameters(
  term: string,
  typeFilter?: string | null,
  instructorFilter?: string | null,
  page = 1,
) {
  const normalized = term.trim();
  return {
    q: normalized || "*",
    query_by: "title,description,summary,body,instructorNames",
    per_page: SEARCH_PAGE_SIZE,
    page,
    sort_by: normalized
      ? "_text_match:desc,updated_at_timestamp:desc"
      : "updated_at_timestamp:desc",
    filter_by: typesenseFilter(typeFilter, instructorFilter),
  };
}

export function legacyTypesenseSearchParameters(
  term: string,
  typeFilter?: string | null,
  instructorNames: readonly string[] = [],
  page = 1,
) {
  const normalized = term.trim();
  const filters = [legacyTypesenseContentFilter(normalizedSearchContentType(typeFilter))];
  if (instructorNames.length) {
    const values = instructorNames.map(typesenseFilterValue).join(",");
    filters.push(`instructor_name:=${instructorNames.length === 1 ? values : `[${values}]`}`);
  }
  return {
    q: normalized || "*",
    query_by: "title,description,summary,instructor_name",
    per_page: SEARCH_PAGE_SIZE,
    page,
    sort_by: normalized
      ? "_text_match:desc,updated_at_timestamp:desc"
      : "updated_at_timestamp:desc",
    filter_by: filters.join(" && "),
  };
}

async function searchTypesenseContent(
  term: string,
  typeFilter?: string | null,
  instructorFilter?: string | null,
  cursor?: SearchCursor | null,
) {
  if (!isEggheadTypesenseSearchConfigured()) return null;

  const page = cursor?.source === "typesense" ? cursor.page : 1;
  const scope = searchScope(term, typeFilter, instructorFilter);
  const config = getEggheadTypesenseConfig();
  const client = createEggheadTypesenseSearchClient();
  if (config.searchSchema === "legacy") {
    const instructor = instructorFilter?.trim();
    const instructorNames = instructor ? await legacyInstructorNamesForFilter(instructor) : [];
    if (instructor && instructorNames.length === 0) return typesenseResultsPage([], 0, 1, scope);
    const response = await client
      .collections<LegacySearchIndexDocument>(config.collectionName)
      .documents()
      .search(legacyTypesenseSearchParameters(term, typeFilter, instructorNames, page));
    const results = (response.hits ?? []).flatMap((hit) => {
      const result = searchResultFromLegacyDocument(hit.document);
      return result ? [result] : [];
    });
    return typesenseResultsPage(results, response.found, page, scope);
  }

  const searchParams = typesenseSearchParameters(term, typeFilter, instructorFilter, page);
  const response = await client
    .collections<SearchIndexDocument>(config.collectionName)
    .documents()
    .search(searchParams);

  const results = (response.hits ?? [])
    .map((hit) => hit.document)
    .filter(Boolean)
    .map(searchResultFromDocument);
  return typesenseResultsPage(results, response.found, page, scope);
}

export async function loadSearchIndexDocuments({
  limit,
}: {
  limit?: number;
} = {}) {
  const filter = await prepareSearchFilter({ term: "" });
  if (!filter) return [];
  const rows = await searchRowsFromDatabase(filter, limit ?? 0);
  const selectedRows = typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : rows;
  return searchDocumentsFromRows(selectedRows);
}

export async function searchContentPage(
  query: SearchQuery,
  cursorToken?: string,
): Promise<SearchResultsPage> {
  "use cache";
  cacheLife("minutes");
  cacheTag("egghead-search");

  const term = query.term.trim();
  const typeFilter = query.contentType?.trim() || null;
  const instructorFilter = query.instructor?.trim() || null;
  const cursor = decodeSearchCursor(cursorToken, searchScope(term, typeFilter, instructorFilter));
  if (cursor?.source === "sql") {
    // A configured legacy catalog must never serve an unrelated SQL traversal.
    if (
      isEggheadTypesenseSearchConfigured() &&
      getEggheadTypesenseConfig().searchSchema === "legacy"
    ) {
      return { kind: "stale-page" };
    }
    return searchSqlContent(term, typeFilter, instructorFilter, cursor);
  }
  try {
    const typesenseResults = await searchTypesenseContent(
      term,
      typeFilter,
      instructorFilter,
      cursor,
    );
    if (typesenseResults) return typesenseResults;
  } catch (error) {
    // A configured legacy catalog must not silently switch to unrelated SQL
    // results (or an empty instructor catalog) when its read contract fails.
    if (getEggheadTypesenseConfig().searchSchema === "legacy") throw error;
    return searchSqlContent(term, typeFilter, instructorFilter, cursor);
  }

  return searchSqlContent(term, typeFilter, instructorFilter, cursor);
}
