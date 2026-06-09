import type { RowDataPacket } from "mysql2";
import { cacheLife, cacheTag } from "next/cache";

import { createLocalMysqlConnection } from "../db/local-docker";
import { descriptionField, fieldsFromJson, stringField } from "./fields";
import { publishedResourceSql } from "./publication";
import {
  canonicalPublicContentPath,
  collectionPath,
  legacyLessonPath,
  type PublicContentFamily,
} from "./routes";

type SearchResourceRow = RowDataPacket & {
  id: string;
  type: string;
  fields: unknown;
};

export type SearchResult = {
  id: string;
  type:
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

const SEARCH_CONTENT_TYPES = new Set<string>(SEARCH_CONTENT_TYPE_VALUES);

function isSearchContentType(value: string): value is SearchContentType {
  return SEARCH_CONTENT_TYPES.has(value);
}

function resultType(type: string, postType: string | null): SearchContentType {
  if (type === "course" || postType === "course") return "course";
  if (type === "lesson" || postType === "lesson") return "lesson";
  if (postType && isSearchContentType(postType)) return postType;
  if (type === "post") return "post";
  return isSearchContentType(type) ? type : "post";
}

function resultHref(type: SearchContentType, slug: string) {
  if (type === "course") return collectionPath(slug);
  if (type === "lesson") return legacyLessonPath(slug);
  if (type !== "post") return canonicalPublicContentPath(type as PublicContentFamily, slug);
  return `/${slug}`;
}

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
    const [rows] = await connection.execute<SearchResourceRow[]>(
      `
          SELECT resource.id, resource.type, resource.fields
          FROM egghead_ContentResource resource
          WHERE resource.deletedAt IS NULL
            ${publishedResourceSql("resource")}
            AND JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.slug')) IS NOT NULL
            AND JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.slug')) != ''
            AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')), resource.type) IN (${publicTypePlaceholders})
            ${typeClause}
            ${termClause}
          ORDER BY resource.createdAt DESC
          LIMIT 24
        `,
      params,
    );

    return rows.map((row) => {
      const fields = fieldsFromJson(row.fields);
      const slug = stringField(fields, "slug") ?? row.id;
      const type = resultType(row.type, stringField(fields, "postType"));

      return {
        id: row.id,
        type,
        title: stringField(fields, "title") ?? "Untitled",
        slug,
        description: descriptionField(fields),
        href: resultHref(type, slug),
      };
    });
  } finally {
    await connection.end();
  }
}
