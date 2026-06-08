import type { RowDataPacket } from "mysql2";
import { cacheLife, cacheTag } from "next/cache";

import { createLocalMysqlConnection } from "../db/local-docker";
import { descriptionField, fieldsFromJson, stringField } from "./fields";

export type PublicContentFamily =
  | "article"
  | "campaign"
  | "case-study"
  | "guide"
  | "podcast"
  | "project"
  | "success-story"
  | "talk"
  | "tip";

type PublicContentRow = RowDataPacket & {
  id: string;
  type: string;
  family: PublicContentFamily;
  fields: unknown;
};

export type PublicContentResource = {
  id: string;
  family: PublicContentFamily;
  title: string;
  slug: string;
  description: string;
  body: string | null;
  sourcePath: string;
  sourceDisposition: string;
};

export function pathForPublicContentFamily(family: PublicContentFamily, slug: string) {
  if (family === "article") return `/${slug}`;
  if (family === "tip") return `/tips/${slug}`;
  if (family === "podcast") return `/podcasts/${slug}`;
  if (family === "talk") return `/talks/${slug}`;
  if (family === "case-study") return `/case-studies/${slug}`;
  if (family === "success-story") return `/success-stories/${slug}`;
  if (family === "guide") return `/guides/${slug}`;
  if (family === "project") return `/projects/${slug}`;
  return `/campaigns/${slug}`;
}

export async function getPublicContentBySlug(
  slug: string,
  families: PublicContentFamily[],
): Promise<PublicContentResource | null> {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-public-content");
  cacheTag(`egghead-public-content:${slug}`);

  if (families.length === 0) return null;

  const connection = await createLocalMysqlConnection();
  const placeholders = families.map(() => "?").join(", ");

  try {
    const [rows] = await connection.execute<PublicContentRow[]>(
      `
        SELECT
          id,
          type,
          COALESCE(JSON_UNQUOTE(JSON_EXTRACT(fields, '$.postType')), type) AS family,
          fields
        FROM egghead_ContentResource
        WHERE deletedAt IS NULL
          AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.slug')) = ?
          AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(fields, '$.postType')), type) IN (${placeholders})
        ORDER BY createdAt DESC
        LIMIT 1
      `,
      [slug, ...families],
    );
    const resource = rows[0];
    if (!resource) return null;

    const fields = fieldsFromJson(resource.fields);
    const resourceSlug = stringField(fields, "slug") ?? slug;
    const path =
      stringField(fields, "path") ?? pathForPublicContentFamily(resource.family, resourceSlug);

    return {
      id: resource.id,
      family: resource.family,
      title: stringField(fields, "title") ?? "Untitled",
      slug: resourceSlug,
      description: descriptionField(fields),
      body: stringField(fields, "body"),
      sourcePath: path,
      sourceDisposition:
        stringField(fields, "contentManifestSource") ?? "coursebuilder_public_content",
    };
  } finally {
    await connection.end();
  }
}

export async function getPublicContentStaticParams(families: PublicContentFamily[]) {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-public-content-static-params");

  if (families.length === 0) return [];

  const connection = await createLocalMysqlConnection();
  const placeholders = families.map(() => "?").join(", ");

  try {
    const [rows] = await connection.execute<Array<RowDataPacket & { slug: string }>>(
      `
        SELECT JSON_UNQUOTE(JSON_EXTRACT(fields, '$.slug')) AS slug
        FROM egghead_ContentResource
        WHERE deletedAt IS NULL
          AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.slug')) IS NOT NULL
          AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(fields, '$.postType')), type) IN (${placeholders})
        ORDER BY createdAt DESC
      `,
      families,
    );

    return rows.map((row) => ({ slug: row.slug }));
  } finally {
    await connection.end();
  }
}
