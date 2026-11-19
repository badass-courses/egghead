import type { RowDataPacket } from "mysql2";
import { cacheLife, cacheTag } from "next/cache";

import { getPublicContentBySlug } from "../content/public-resource";
import { publishedResourceSql } from "../content/publication";
import { contentResourceSlugSql } from "../content/resource-slug";
import { createLocalMysqlConnection } from "../db/local-docker";

type SlugRow = RowDataPacket & { slug: string | null };

function escapeLike(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

// Legacy /blog/<slug> links often use the slug without CourseBuilder's
// "~abc12" suffix. Resolve only a unique suffixed match, so an ambiguous
// slug 404s instead of guessing.
async function suffixedArticleSlug(slug: string): Promise<string | null> {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-public-content");
  cacheTag(`egghead-article-alias:${slug}`);

  const connection = await createLocalMysqlConnection();
  try {
    const slugSql = await contentResourceSlugSql(connection, "resource");
    const [rows] = await connection.execute<SlugRow[]>(
      `
        SELECT DISTINCT ${slugSql} AS slug
        FROM egghead_ContentResource resource
        WHERE resource.deletedAt IS NULL
          ${publishedResourceSql("resource")}
          AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')), resource.type) = 'article'
          AND ${slugSql} LIKE ?
        LIMIT 2
      `,
      [`${escapeLike(slug)}~%`],
    );
    return rows.length === 1 ? (rows[0]?.slug ?? null) : null;
  } finally {
    await connection.end();
  }
}

// Canonical path of the article a /blog/<slug> link means, or null.
export async function articleCanonicalPathForLegacySlug(slug: string): Promise<string | null> {
  const exact = await getPublicContentBySlug(slug, ["article"]);
  if (exact) return exact.canonicalPath;

  if (slug.includes("~")) return null;
  const suffixed = await suffixedArticleSlug(slug);
  if (!suffixed) return null;

  return (await getPublicContentBySlug(suffixed, ["article"]))?.canonicalPath ?? null;
}
