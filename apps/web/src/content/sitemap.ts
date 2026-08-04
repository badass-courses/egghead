import type { RowDataPacket } from "mysql2";
import type { MetadataRoute } from "next";
import { cacheLife, cacheTag } from "next/cache";

import { createLocalMysqlConnection } from "../db/local-docker";
import { contentResourceSlugSql } from "./resource-slug";
import { publishedResourceSql, routeableLessonResourceSql } from "./publication";
import {
  STANDALONE_PUBLIC_CONTENT_FAMILIES,
  canonicalPodcastPath,
  canonicalPublicContentPath,
  collectionPath,
  standaloneContentPath,
  type PublicContentFamily,
} from "./routes";

export const EGGHEAD_SITE_URL = "https://egghead.io";

export const SITEMAP_STATIC_PATHS = [
  "/",
  "/courses",
  "/lessons",
  "/blog",
  "/podcasts",
  "/talks",
  "/case-studies",
  "/success-stories",
  "/campaigns",
] as const;

export const SITEMAP_EXCLUDED_LEGACY_PREFIXES = [
  "/courses/",
  "/lessons/",
  "/blog/",
  "/podcasts/",
  "/talks/",
  "/case-studies/",
  "/success-stories/",
  "/campaigns/",
] as const;

type SitemapEntry = MetadataRoute.Sitemap[number];

type SitemapRow = RowDataPacket & {
  path: string | null;
  updatedAt: Date | string | null;
};

function placeholders(values: readonly unknown[]) {
  return values.map(() => "?").join(", ");
}

function jsonString(alias: string, key: string) {
  return `JSON_UNQUOTE(JSON_EXTRACT(${alias}.fields, '$.${key}'))`;
}

function courseResourceCondition(alias: string) {
  return `
    (
      ${alias}.type = 'course'
      OR (
        ${alias}.type = 'post'
        AND ${jsonString(alias, "postType")} = 'course'
      )
    )
  `;
}

function lessonResourceCondition(alias: string) {
  return `
    (
      ${alias}.type = 'lesson'
      OR (
        ${alias}.type = 'post'
        AND ${jsonString(alias, "postType")} = 'lesson'
      )
    )
  `;
}

function timestamp(value: Date | string | null | undefined) {
  if (value instanceof Date) return value;
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function absoluteSitemapUrl(path: string) {
  return `${EGGHEAD_SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

function sitemapEntry(
  path: string,
  updatedAt?: Date | string | null,
  priority = 0.7,
): SitemapEntry {
  const lastModified = timestamp(updatedAt);

  return {
    url: absoluteSitemapUrl(path),
    changeFrequency: "weekly",
    priority,
    ...(lastModified ? { lastModified } : {}),
  };
}

function uniqueEntries(entries: SitemapEntry[]) {
  const seen = new Set<string>();
  const result: SitemapEntry[] = [];

  for (const entry of entries) {
    if (seen.has(entry.url)) continue;
    seen.add(entry.url);
    result.push(entry);
  }

  return result;
}

async function courseRows(connection: Awaited<ReturnType<typeof createLocalMysqlConnection>>) {
  const courseSlugSql = await contentResourceSlugSql(connection, "course");
  const [rows] = await connection.execute<SitemapRow[]>(
    `
      SELECT ${courseSlugSql} AS path, course.updatedAt
      FROM egghead_ContentResource course
      WHERE course.deletedAt IS NULL
        ${publishedResourceSql("course")}
        AND ${courseSlugSql} IS NOT NULL
        AND ${courseSlugSql} != ''
        AND ${courseResourceCondition("course")}
      ORDER BY course.updatedAt DESC, course.createdAt DESC
    `,
  );

  return rows
    .filter((row) => row.path)
    .map((row) => sitemapEntry(collectionPath(row.path ?? ""), row.updatedAt, 0.9));
}

async function collectionLessonRows(
  connection: Awaited<ReturnType<typeof createLocalMysqlConnection>>,
) {
  const courseSlugSql = await contentResourceSlugSql(connection, "course");
  const lessonSlugSql = await contentResourceSlugSql(connection, "lesson");
  const [rows] = await connection.execute<SitemapRow[]>(
    `
      SELECT route.path, MAX(route.updatedAt) AS updatedAt
      FROM (
        SELECT
          CONCAT('/', ${courseSlugSql}, '/', ${lessonSlugSql}) AS path,
          lesson.updatedAt AS updatedAt
        FROM egghead_ContentResourceResource directLink
        JOIN egghead_ContentResource course
          ON course.id = directLink.resourceOfId
         AND course.deletedAt IS NULL
         ${publishedResourceSql("course")}
        JOIN egghead_ContentResource lesson
          ON lesson.id = directLink.resourceId
         AND lesson.deletedAt IS NULL
         ${routeableLessonResourceSql("lesson")}
        WHERE ${courseResourceCondition("course")}
          AND ${lessonResourceCondition("lesson")}
          AND ${courseSlugSql} IS NOT NULL
          AND ${courseSlugSql} != ''
          AND ${lessonSlugSql} IS NOT NULL
          AND ${lessonSlugSql} != ''

        UNION ALL

        SELECT
          CONCAT('/', ${courseSlugSql}, '/', ${lessonSlugSql}) AS path,
          lesson.updatedAt AS updatedAt
        FROM egghead_ContentResourceResource sectionLink
        JOIN egghead_ContentResource course
          ON course.id = sectionLink.resourceOfId
         AND course.deletedAt IS NULL
         ${publishedResourceSql("course")}
        JOIN egghead_ContentResource section
          ON section.id = sectionLink.resourceId
         AND section.deletedAt IS NULL
         ${publishedResourceSql("section")}
        JOIN egghead_ContentResourceResource lessonLink
          ON lessonLink.resourceOfId = section.id
        JOIN egghead_ContentResource lesson
          ON lesson.id = lessonLink.resourceId
         AND lesson.deletedAt IS NULL
         ${routeableLessonResourceSql("lesson")}
        WHERE ${courseResourceCondition("course")}
          AND section.type = 'section'
          AND ${lessonResourceCondition("lesson")}
          AND ${courseSlugSql} IS NOT NULL
          AND ${courseSlugSql} != ''
          AND ${lessonSlugSql} IS NOT NULL
          AND ${lessonSlugSql} != ''
      ) route
      GROUP BY route.path
      ORDER BY MAX(route.updatedAt) DESC
    `,
  );

  return rows
    .filter((row) => row.path)
    .map((row) => sitemapEntry(row.path ?? "", row.updatedAt, 0.7));
}

async function standaloneLessonRows(
  connection: Awaited<ReturnType<typeof createLocalMysqlConnection>>,
) {
  const lessonSlugSql = await contentResourceSlugSql(connection, "lesson");
  const [rows] = await connection.execute<SitemapRow[]>(
    `
      SELECT lesson_slug.slug AS path, MAX(lesson_slug.updatedAt) AS updatedAt
      FROM (
        SELECT
          lesson.id,
          ${lessonSlugSql} AS slug,
          lesson.updatedAt
        FROM egghead_ContentResource lesson
        WHERE lesson.deletedAt IS NULL
          ${routeableLessonResourceSql("lesson")}
          AND ${lessonSlugSql} IS NOT NULL
          AND ${lessonSlugSql} != ''
          AND ${lessonResourceCondition("lesson")}
      ) lesson_slug
      WHERE NOT EXISTS (
        SELECT 1
        FROM egghead_ContentResourceResource directLink
        JOIN egghead_ContentResource parent
          ON parent.id = directLink.resourceOfId
         AND parent.deletedAt IS NULL
         ${publishedResourceSql("parent")}
        WHERE directLink.resourceId = lesson_slug.id
          AND ${courseResourceCondition("parent")}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM egghead_ContentResourceResource lessonLink
        JOIN egghead_ContentResource section
          ON section.id = lessonLink.resourceOfId
         AND section.deletedAt IS NULL
         ${publishedResourceSql("section")}
        JOIN egghead_ContentResourceResource sectionLink
          ON sectionLink.resourceId = section.id
        JOIN egghead_ContentResource parent
          ON parent.id = sectionLink.resourceOfId
         AND parent.deletedAt IS NULL
         ${publishedResourceSql("parent")}
        WHERE lessonLink.resourceId = lesson_slug.id
          AND section.type = 'section'
          AND ${courseResourceCondition("parent")}
      )
      GROUP BY lesson_slug.slug
      ORDER BY MAX(lesson_slug.updatedAt) DESC
    `,
  );

  return rows
    .filter((row) => row.path)
    .map((row) => sitemapEntry(standaloneContentPath(row.path ?? ""), row.updatedAt, 0.7));
}

async function publicContentRows(
  connection: Awaited<ReturnType<typeof createLocalMysqlConnection>>,
) {
  const families = [...STANDALONE_PUBLIC_CONTENT_FAMILIES];
  const resourceSlugSql = await contentResourceSlugSql(connection, "resource");
  const familySql = `COALESCE(${jsonString("resource", "postType")}, resource.type)`;
  const [rows] = await connection.execute<
    Array<
      SitemapRow & {
        contentResourceKind: string | null;
        family: PublicContentFamily;
        podcastShowSlug: string | null;
      }
    >
  >(
    `
      SELECT
        ${familySql} AS family,
        ${resourceSlugSql} AS path,
        ${jsonString("resource", "contentResourceKind")} AS contentResourceKind,
        ${jsonString("resource", "podcastShowSlug")} AS podcastShowSlug,
        MAX(resource.updatedAt) AS updatedAt
      FROM egghead_ContentResource resource
      WHERE resource.deletedAt IS NULL
        ${publishedResourceSql("resource")}
        AND ${resourceSlugSql} IS NOT NULL
        AND ${resourceSlugSql} != ''
        AND ${familySql} IN (${placeholders(families)})
      GROUP BY ${familySql}, ${resourceSlugSql}, ${jsonString("resource", "contentResourceKind")}, ${jsonString("resource", "podcastShowSlug")}
      ORDER BY MAX(resource.updatedAt) DESC
    `,
    families,
  );

  return rows
    .filter((row) => row.path)
    .map((row) =>
      sitemapEntry(
        row.family === "podcast"
          ? canonicalPodcastPath(row.path ?? "", row.podcastShowSlug, row.contentResourceKind)
          : canonicalPublicContentPath(row.family, row.path ?? ""),
        row.updatedAt,
        row.family === "article" ? 0.8 : 0.7,
      ),
    );
}

export async function getEggheadSitemapEntriesUncached(): Promise<MetadataRoute.Sitemap> {
  const connection = await createLocalMysqlConnection();

  try {
    const courses = await courseRows(connection);
    const collectionLessons = await collectionLessonRows(connection);
    const standaloneLessons = await standaloneLessonRows(connection);
    const publicResources = await publicContentRows(connection);

    const staticEntries = SITEMAP_STATIC_PATHS.map((path) =>
      sitemapEntry(path, null, path === "/" ? 1 : 0.6),
    );

    return uniqueEntries([
      ...staticEntries,
      ...courses,
      ...collectionLessons,
      ...standaloneLessons,
      ...publicResources,
    ]);
  } finally {
    await connection.end();
  }
}

export async function getEggheadSitemapEntries(): Promise<MetadataRoute.Sitemap> {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-sitemap");
  cacheTag("egghead-content");

  return getEggheadSitemapEntriesUncached();
}

export function robotsPolicy(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/login", "/logout"],
    },
    sitemap: absoluteSitemapUrl("/sitemap.xml"),
  };
}
