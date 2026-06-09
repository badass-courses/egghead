import type { RowDataPacket } from "mysql2";
import { cacheLife, cacheTag } from "next/cache";

import { createLocalMysqlConnection } from "../db/local-docker";
import { descriptionField, fieldsFromJson, markdownField, stringField } from "./fields";
import { publishedResourceSql } from "./publication";
import {
  canonicalPublicContentPath,
  legacyPublicContentPath,
  type PublicContentFamily,
} from "./routes";

export type { PublicContentFamily } from "./routes";

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
  canonicalPath: string;
  imageUrl: string | null;
  mediaUrl: string | null;
  videoHlsUrl: string | null;
  videoDashUrl: string | null;
  thumbnailUrl: string | null;
  sourcePath: string;
  sourceDisposition: string;
};

export function pathForPublicContentFamily(family: PublicContentFamily, slug: string) {
  return canonicalPublicContentPath(family, slug);
}

export function legacyPathForPublicContentFamily(family: PublicContentFamily, slug: string) {
  return legacyPublicContentPath(family, slug);
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
          resource.id,
          resource.type,
          COALESCE(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')), resource.type) AS family,
          resource.fields
        FROM egghead_ContentResource resource
        WHERE resource.deletedAt IS NULL
          ${publishedResourceSql("resource")}
          AND JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.slug')) = ?
          AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')), resource.type) IN (${placeholders})
        ORDER BY resource.createdAt DESC
        LIMIT 1
      `,
      [slug, ...families],
    );
    const resource = rows[0];
    if (!resource) return null;

    const fields = fieldsFromJson(resource.fields);
    const resourceSlug = stringField(fields, "slug") ?? slug;
    const path =
      stringField(fields, "path") ??
      legacyPathForPublicContentFamily(resource.family, resourceSlug);

    return {
      id: resource.id,
      family: resource.family,
      title: stringField(fields, "title") ?? "Untitled",
      slug: resourceSlug,
      description: descriptionField(fields),
      body: markdownField(fields),
      canonicalPath: pathForPublicContentFamily(resource.family, resourceSlug),
      imageUrl:
        stringField(fields, "imageUrl") ??
        stringField(fields, "image") ??
        stringField(fields, "ogImage") ??
        stringField(fields, "thumbnailUrl"),
      mediaUrl: stringField(fields, "mediaUrl") ?? stringField(fields, "audioUrl"),
      videoHlsUrl: stringField(fields, "currentVideoHlsUrl") ?? stringField(fields, "hlsUrl"),
      videoDashUrl: stringField(fields, "currentVideoDashUrl"),
      thumbnailUrl: stringField(fields, "thumbnailUrl") ?? stringField(fields, "thumbUrl"),
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
        SELECT resource_slug.slug
        FROM (
          SELECT
            JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.slug')) AS slug,
            resource.createdAt
          FROM egghead_ContentResource resource
          WHERE resource.deletedAt IS NULL
            ${publishedResourceSql("resource")}
            AND JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.slug')) IS NOT NULL
            AND JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.slug')) != ''
            AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')), resource.type) IN (${placeholders})
        ) resource_slug
        GROUP BY resource_slug.slug
        ORDER BY MAX(resource_slug.createdAt) DESC
      `,
      families,
    );

    return rows.map((row) => ({ slug: row.slug }));
  } finally {
    await connection.end();
  }
}
