import type { RowDataPacket } from "mysql2";
import { cacheLife, cacheTag } from "next/cache";

import { getPublicContentBySlug } from "../content/public-resource";
import { publishedResourceSql } from "../content/publication";
import { contentResourceSlugSql } from "../content/resource-slug";
import { STANDALONE_PUBLIC_CONTENT_FAMILIES } from "../content/routes";
// The same runtime-guarded connector content/public-resource.ts uses: it
// reads DATABASE_URL and allows local Docker, approved beta PlanetScale or
// production PlanetScale by EGGHEAD_RUNTIME. "local" is only its old name.
import { createLocalMysqlConnection } from "../db/local-docker";

type SlugRow = RowDataPacket & { slug: string | null };

// The longest content slug in the beta sitemap on 2026-11-19 was 105
// characters. Longer /blog slugs are 404s without a database lookup, so
// random long paths cannot grow the cache.
export const MAX_LEGACY_SLUG_LENGTH = 160;

export function isLookupableSlug(slug: string) {
  return slug.length > 0 && slug.length <= MAX_LEGACY_SLUG_LENGTH && !slug.includes("/");
}

// LIKE escape with "!" (passed as ESCAPE '!'), so the result does not depend
// on the server's NO_BACKSLASH_ESCAPES mode.
export function escapeLike(value: string) {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

// One match is the article; none or several is a 404, never a guess.
export function uniqueSlug(rows: readonly { slug: string | null }[]): string | null {
  return rows.length === 1 ? (rows[0]?.slug ?? null) : null;
}

// Legacy /blog/<slug> links often use the slug without CourseBuilder's
// "~abc12" suffix. Resolve only a unique suffixed match. A hit is cached for
// hours; a miss for minutes, so an article published after a miss resolves
// soon. One shared tag, not one per slug, so random slugs add no tags.
async function suffixedArticleSlug(slug: string): Promise<string | null> {
  "use cache";
  cacheTag("egghead-public-content");

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
          AND ${slugSql} LIKE ? ESCAPE '!'
        LIMIT 2
      `,
      [`${escapeLike(slug)}~%`],
    );
    const match = uniqueSlug(rows);
    if (match) {
      cacheLife("hours");
    } else {
      cacheLife("minutes");
    }
    return match;
  } finally {
    await connection.end();
  }
}

// Where a /blog/<slug> link should go, or null for a 404:
// 1. any public post with that exact slug (articles, talks, podcasts, case
//    studies, ...), at its canonical URL, usually /<slug>;
// 2. otherwise a unique "~suffix" article match.
export async function articleCanonicalPathForLegacySlug(slug: string): Promise<string | null> {
  if (!isLookupableSlug(slug)) return null;

  const exact = await getPublicContentBySlug(slug, [...STANDALONE_PUBLIC_CONTENT_FAMILIES]);
  if (exact) return exact.canonicalPath;

  if (slug.includes("~")) return null;
  const suffixed = await suffixedArticleSlug(slug);
  if (!suffixed) return null;

  return (await getPublicContentBySlug(suffixed, ["article"]))?.canonicalPath ?? null;
}
