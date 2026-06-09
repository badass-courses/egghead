import type { RowDataPacket } from "mysql2";
import { cacheLife, cacheTag } from "next/cache";

import { createLocalMysqlConnection } from "../db/local-docker";
import { parentCourseSlugsForLessonIds } from "./lesson-route-context";
import { publishedResourceSql } from "./publication";
import { contentResourceSlugSql } from "./resource-slug";
import {
  searchDocumentFromResource,
  searchDocumentTypeFromResource,
  type SearchDocumentType,
} from "./search-document";

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

const SEARCH_CONTENT_TYPE_VALUES = [
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

export async function searchContent(
  term: string,
  typeFilter?: string | null,
): Promise<SearchResult[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag("egghead-search");

  const connection = await createLocalMysqlConnection();
  const normalized = term.trim().toLowerCase();
  const likeTerm = `%${normalized}%`;
  const normalizedType = typeFilter?.trim() || null;
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
  const params = [
    ...SEARCH_CONTENT_TYPE_VALUES,
    ...(normalizedType ? [normalizedType] : []),
    ...(normalized ? [likeTerm, likeTerm, likeTerm] : []),
  ];

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
          ORDER BY resource.createdAt DESC
          LIMIT 24
        `,
      params,
    );

    const parentCourseSlugs = await parentCourseSlugsForLessonIds(
      connection,
      rows.filter((row) => searchDocumentTypeFromResource(row) === "lesson").map((row) => row.id),
    );

    return rows.map((row) => {
      const document = searchDocumentFromResource({
        parentCourseSlug: parentCourseSlugs.get(row.id),
        resource: row,
      });

      return {
        id: document.id,
        type: document.type,
        title: document.title,
        slug: document.slug,
        description: document.description,
        href: document.path,
      };
    });
  } finally {
    await connection.end();
  }
}
