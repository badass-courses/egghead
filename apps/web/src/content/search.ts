import { cache } from "react";
import type { RowDataPacket } from "mysql2";

import { createLocalMysqlConnection } from "../db/local-docker";
import { fieldsFromJson, stringField } from "./fields";

type SearchResourceRow = RowDataPacket & {
  id: string;
  type: string;
  fields: unknown;
};

export type SearchResult = {
  id: string;
  type: "course" | "lesson" | "post";
  title: string;
  slug: string;
  description: string;
  href: string;
};

function resultType(type: string, postType: string | null): SearchResult["type"] {
  if (type === "course" || postType === "course") return "course";
  if (type === "lesson" || postType === "lesson") return "lesson";
  return "post";
}

function resultHref(type: SearchResult["type"], slug: string) {
  if (type === "course") return `/courses/${slug}`;
  if (type === "lesson") return `/lessons/${slug}`;
  return `/articles/${slug}`;
}

export const searchContent = cache(async (term: string): Promise<SearchResult[]> => {
  const connection = await createLocalMysqlConnection();
  const normalized = term.trim().toLowerCase();
  const likeTerm = `%${normalized}%`;

  try {
    const [rows] = await connection.execute<SearchResourceRow[]>(
      normalized
        ? `
          SELECT id, type, fields
          FROM egghead_ContentResource
          WHERE deletedAt IS NULL
            AND (
              LOWER(JSON_UNQUOTE(JSON_EXTRACT(fields, '$.title'))) LIKE ?
              OR LOWER(JSON_UNQUOTE(JSON_EXTRACT(fields, '$.description'))) LIKE ?
              OR LOWER(JSON_UNQUOTE(JSON_EXTRACT(fields, '$.summary'))) LIKE ?
            )
          ORDER BY createdAt DESC
          LIMIT 24
        `
        : `
          SELECT id, type, fields
          FROM egghead_ContentResource
          WHERE deletedAt IS NULL
          ORDER BY createdAt DESC
          LIMIT 24
        `,
      normalized ? [likeTerm, likeTerm, likeTerm] : [],
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
        description: stringField(fields, "description") ?? stringField(fields, "summary") ?? "",
        href: resultHref(type, slug),
      };
    });
  } finally {
    await connection.end();
  }
});
