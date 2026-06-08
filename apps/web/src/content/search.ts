import type { RowDataPacket } from "mysql2";
import { cacheLife, cacheTag } from "next/cache";

import { createLocalMysqlConnection } from "../db/local-docker";
import { descriptionField, fieldsFromJson, stringField } from "./fields";

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

const SEARCH_CONTENT_TYPES = new Set<string>([
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
  if (type === "course") return `/courses/${slug}`;
  if (type === "lesson") return `/lessons/${slug}`;
  if (type === "tip") return `/tips/${slug}`;
  if (type === "podcast") return `/podcasts/${slug}`;
  if (type === "talk") return `/talks/${slug}`;
  if (type === "case-study") return `/case-studies/${slug}`;
  if (type === "success-story") return `/success-stories/${slug}`;
  if (type === "guide") return `/guides/${slug}`;
  if (type === "project") return `/projects/${slug}`;
  if (type === "campaign") return `/campaigns/${slug}`;
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
    ? "AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(fields, '$.postType')), type) = ?"
    : "";
  const termClause = normalized
    ? `
            AND (
              LOWER(JSON_UNQUOTE(JSON_EXTRACT(fields, '$.title'))) LIKE ?
              OR LOWER(JSON_UNQUOTE(JSON_EXTRACT(fields, '$.description'))) LIKE ?
              OR LOWER(JSON_UNQUOTE(JSON_EXTRACT(fields, '$.summary'))) LIKE ?
            )
        `
    : "";
  const params = [
    ...(normalizedType ? [normalizedType] : []),
    ...(normalized ? [likeTerm, likeTerm, likeTerm] : []),
  ];

  try {
    const [rows] = await connection.execute<SearchResourceRow[]>(
      `
          SELECT id, type, fields
          FROM egghead_ContentResource
          WHERE deletedAt IS NULL
            ${typeClause}
            ${termClause}
          ORDER BY createdAt DESC
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
