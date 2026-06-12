import type { RowDataPacket } from "mysql2";
import { cacheLife, cacheTag } from "next/cache";

import { createLocalMysqlConnection } from "../db/local-docker";
import { descriptionField, fieldsFromJson, stringField } from "./fields";
import { lessonFreeForeverSql } from "./lesson-access";
import { publishedResourceSql } from "./publication";
import { contentResourceSlugSql } from "./resource-slug";
import { collectionPath } from "./routes";
import { pathForPublicContentFamily, type PublicContentFamily } from "./public-resource";

const PUBLIC_CONTENT_FAMILIES = [
  "article",
  "campaign",
  "case-study",
  "guide",
  "podcast",
  "project",
  "success-story",
  "talk",
  "tip",
] satisfies PublicContentFamily[];

type HomeResourceRow = RowDataPacket & {
  id: string;
  family: string | null;
  fields: unknown;
  tagLabel: string | null;
  lessonCount: number | string | null;
  muxPlaybackId: string | null;
};

export type HomeContentItem = {
  id: string;
  family: "course" | PublicContentFamily;
  title: string;
  slug: string;
  description: string;
  href: string;
  imageUrl: string | null;
  tagLabel: string | null;
  lessonCount: number | null;
};

export type HomeStats = {
  courses: number;
  lessons: number;
  articles: number;
};

export type HomeContent = {
  courses: HomeContentItem[];
  resources: HomeContentItem[];
  stats: HomeStats;
};

function isPublicContentFamily(value: string | null): value is PublicContentFamily {
  return PUBLIC_CONTENT_FAMILIES.some((family) => family === value);
}

/* First content tag by position, label preferred over name. NULLIF guards
   JSON null serialized as the string "null". */
const TAG_LABEL_SQL = `
  (SELECT COALESCE(
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(tag.fields, '$.label')), 'null'),
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(tag.fields, '$.name')), 'null')
    )
    FROM egghead_ContentResourceTag crt
    JOIN egghead_Tag tag
      ON tag.id = crt.tagId
     AND tag.deletedAt IS NULL
    WHERE crt.contentResourceId = resource.id
    ORDER BY crt.position ASC
    LIMIT 1)
`;

function cleanLabel(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  return trimmed;
}

function imageUrlFromFields(fields: ReturnType<typeof fieldsFromJson>): string | null {
  return (
    stringField(fields, "image") ??
    stringField(fields, "imageUrl") ??
    stringField(fields, "ogImage") ??
    stringField(fields, "thumbnailUrl")
  );
}

/* Mux serves public poster frames per playback id. Only ever called with
   ids that are already publicly served (free lessons, public resources) —
   exposing an id here exposes the stream, so gated content must not reach
   this function. */
function muxThumbnailUrl(playbackId: string | null): string | null {
  if (!playbackId) return null;
  return `https://image.mux.com/${playbackId}/thumbnail.webp?width=448&height=270&fit_mode=smartcrop`;
}

function toCourseItem(row: HomeResourceRow): HomeContentItem | null {
  const fields = fieldsFromJson(row.fields);
  const slug = stringField(fields, "slug");
  if (!slug) return null;

  const linkedLessonCount = Number(row.lessonCount ?? 0);

  return {
    id: row.id,
    family: "course",
    title: stringField(fields, "title") ?? "Untitled course",
    slug,
    description: descriptionField(fields),
    href: collectionPath(slug),
    imageUrl: muxThumbnailUrl(cleanLabel(row.muxPlaybackId)) ?? imageUrlFromFields(fields),
    tagLabel: cleanLabel(row.tagLabel),
    lessonCount: linkedLessonCount > 0 ? linkedLessonCount : null,
  };
}

function toPublicItem(row: HomeResourceRow): HomeContentItem | null {
  const fields = fieldsFromJson(row.fields);
  const family = isPublicContentFamily(row.family) ? row.family : null;
  const slug = stringField(fields, "slug");
  if (!family || !slug) return null;

  return {
    id: row.id,
    family,
    title: stringField(fields, "title") ?? "Untitled",
    slug,
    description: descriptionField(fields),
    href: stringField(fields, "path") ?? pathForPublicContentFamily(family, slug),
    imageUrl:
      muxThumbnailUrl(cleanLabel(row.muxPlaybackId) ?? stringField(fields, "muxPlaybackId")) ??
      imageUrlFromFields(fields),
    tagLabel: cleanLabel(row.tagLabel),
    lessonCount: null,
  };
}

export async function getHomeContent(): Promise<HomeContent> {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-home");
  cacheTag("egghead-content");

  const connection = await createLocalMysqlConnection();
  const publicFamilyPlaceholders = PUBLIC_CONTENT_FAMILIES.map(() => "?").join(", ");

  try {
    const resourceSlugSql = await contentResourceSlugSql(connection, "resource");
    const [courseRows] = await connection.execute<HomeResourceRow[]>(
      `
        SELECT
          resource.id,
          'course' AS family,
          resource.fields,
          ${TAG_LABEL_SQL} AS tagLabel,
          (SELECT COALESCE(
              NULLIF(JSON_UNQUOTE(JSON_EXTRACT(lesson.fields, '$.muxPlaybackId')), 'null'),
              (SELECT NULLIF(JSON_UNQUOTE(JSON_EXTRACT(video.fields, '$.muxPlaybackId')), 'null')
                FROM egghead_ContentResourceResource videoLink
                JOIN egghead_ContentResource video
                  ON video.id = videoLink.resourceId
                 AND video.deletedAt IS NULL
                 AND video.type = 'videoResource'
                WHERE videoLink.resourceOfId = lesson.id
                ORDER BY videoLink.position ASC
                LIMIT 1)
            )
            FROM egghead_ContentResourceResource link
            JOIN egghead_ContentResource lesson
              ON lesson.id = link.resourceId
             AND lesson.deletedAt IS NULL
            WHERE link.resourceOfId = resource.id
              AND (
                lesson.type = 'lesson'
                OR (
                  lesson.type = 'post'
                  AND JSON_UNQUOTE(JSON_EXTRACT(lesson.fields, '$.postType')) = 'lesson'
                )
              )
              AND ${lessonFreeForeverSql("lesson")}
            ORDER BY link.position ASC, lesson.createdAt ASC
            LIMIT 1
          ) AS muxPlaybackId,
          (SELECT COUNT(*)
            FROM egghead_ContentResourceResource link
            JOIN egghead_ContentResource lesson
              ON lesson.id = link.resourceId
             AND lesson.deletedAt IS NULL
            WHERE link.resourceOfId = resource.id
              AND (
                lesson.type = 'lesson'
                OR (
                  lesson.type = 'post'
                  AND JSON_UNQUOTE(JSON_EXTRACT(lesson.fields, '$.postType')) = 'lesson'
                )
              )
          ) AS lessonCount
        FROM egghead_ContentResource resource
        WHERE resource.deletedAt IS NULL
          ${publishedResourceSql("resource")}
          AND ${resourceSlugSql} IS NOT NULL
          AND ${resourceSlugSql} != ''
          AND (
            resource.type = 'course'
            OR (
              resource.type = 'post'
              AND JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')) = 'course'
            )
          )
        ORDER BY resource.createdAt DESC
        LIMIT 6
      `,
    );

    const [resourceRows] = await connection.execute<HomeResourceRow[]>(
      `
        SELECT
          resource.id,
          COALESCE(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')), resource.type) AS family,
          resource.fields,
          ${TAG_LABEL_SQL} AS tagLabel,
          (SELECT NULLIF(JSON_UNQUOTE(JSON_EXTRACT(video.fields, '$.muxPlaybackId')), 'null')
            FROM egghead_ContentResourceResource videoLink
            JOIN egghead_ContentResource video
              ON video.id = videoLink.resourceId
             AND video.deletedAt IS NULL
             AND video.type = 'videoResource'
            WHERE videoLink.resourceOfId = resource.id
            ORDER BY videoLink.position ASC
            LIMIT 1
          ) AS muxPlaybackId,
          NULL AS lessonCount
        FROM egghead_ContentResource resource
        WHERE resource.deletedAt IS NULL
          ${publishedResourceSql("resource")}
          AND ${resourceSlugSql} IS NOT NULL
          AND ${resourceSlugSql} != ''
          AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')), resource.type) IN (${publicFamilyPlaceholders})
        ORDER BY resource.createdAt DESC
        LIMIT 10
      `,
      [...PUBLIC_CONTENT_FAMILIES],
    );

    type StatsRow = RowDataPacket & {
      courses: number | string | null;
      lessons: number | string | null;
      articles: number | string | null;
    };

    const [statsRows] = await connection.execute<StatsRow[]>(
      `
        SELECT
          SUM(
            resource.type = 'course'
            OR (
              resource.type = 'post'
              AND JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')) = 'course'
            )
          ) AS courses,
          SUM(
            resource.type = 'lesson'
            OR (
              resource.type = 'post'
              AND JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')) = 'lesson'
            )
          ) AS lessons,
          SUM(
            resource.type = 'post'
            AND JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')) = 'article'
          ) AS articles
        FROM egghead_ContentResource resource
        WHERE resource.deletedAt IS NULL
          ${publishedResourceSql("resource")}
      `,
    );
    const statsRow = statsRows[0];

    return {
      courses: courseRows
        .map(toCourseItem)
        .filter((item): item is HomeContentItem => item !== null),
      resources: resourceRows
        .map(toPublicItem)
        .filter((item): item is HomeContentItem => item !== null),
      stats: {
        courses: Number(statsRow?.courses ?? 0),
        lessons: Number(statsRow?.lessons ?? 0),
        articles: Number(statsRow?.articles ?? 0),
      },
    };
  } finally {
    await connection.end();
  }
}
