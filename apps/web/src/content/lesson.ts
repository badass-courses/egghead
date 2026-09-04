import type { RowDataPacket } from "mysql2";
import type { Connection } from "mysql2/promise";
import { cacheLife, cacheTag } from "next/cache";

import { createLocalMysqlConnection } from "../db/local-docker";
import {
  booleanField,
  excerptField,
  fieldsFromJson,
  markdownField,
  numberField,
  stringField,
} from "./fields";
import {
  LESSON_STATIC_PARAM_LIMIT,
  publishedResourceSql,
  routeableLessonResourceSql,
} from "./publication";
import { lessonAccessFromFields, lessonHasRailsProContentSignal } from "./lesson-access";
import { canonicalLessonOrderSql } from "./canonical-order";
import { contentResourceSlugSql } from "./resource-slug";
import { HOT_LESSON_STATIC_PARAMS } from "./hot-lesson-static-params";
import { collectionEntryPath, legacyLessonPath, standaloneContentPath } from "./routes";

type ContentResourceRow = RowDataPacket & {
  id: string;
  type: string;
  fields: unknown;
  createdAt: Date;
  updatedAt: Date;
};

type ParentCourseRow = ContentResourceRow & {
  position: number;
};

type VideoResourceRow = ContentResourceRow & {
  position: number;
};

type SameSlugRailsTruthRow = RowDataPacket & {
  freeRows: number | string | null;
  proRows: number | string | null;
};

export type LessonForPage = {
  id: string;
  title: string;
  slug: string;
  description: string;
  body: string | null;
  duration: number | null;
  freeForever: boolean;
  isProContent: boolean;
  courseLinked: boolean;
  parentCourseId: string | null;
  parentCourseSlug: string | null;
  parentCourseTitle: string | null;
  parentCourseLegacyRailsPlaylistId: number | null;
  canonicalPath: string;
  legacyPath: string;
  hasTranscript: boolean;
  hasSrt: boolean;
  state: string | null;
  visibilityState: string | null;
  hasVideo: boolean;
};

type LessonStaticParamRow = RowDataPacket & {
  slug: string;
};

function sqlString(value: string) {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

function hotLessonStaticParamSql() {
  if (HOT_LESSON_STATIC_PARAMS.length === 0) {
    return "SELECT NULL AS slug, NULL AS popularityRank, NULL AS requests720h WHERE FALSE";
  }

  return HOT_LESSON_STATIC_PARAMS.map(
    (row) =>
      `SELECT ${sqlString(row.slug)} AS slug, ${row.popularityRank} AS popularityRank, ${row.requests720h} AS requests720h`,
  ).join(" UNION ALL ");
}

function lessonResourceCondition(alias: string) {
  return `
    (
      ${alias}.type = 'lesson'
      OR (
        ${alias}.type = 'post'
        AND JSON_UNQUOTE(JSON_EXTRACT(${alias}.fields, '$.postType')) = 'lesson'
      )
    )
  `;
}

function courseResourceCondition(alias: string) {
  return `
    (
      ${alias}.type = 'course'
      OR (
        ${alias}.type = 'post'
        AND JSON_UNQUOTE(JSON_EXTRACT(${alias}.fields, '$.postType')) = 'course'
      )
    )
  `;
}

function muxThumbnailUrl(playbackId: string | null) {
  return playbackId ? `https://image.mux.com/${playbackId}/thumbnail.webp?time=0` : null;
}

async function parentCoursesForLesson(
  connection: Awaited<ReturnType<typeof createLocalMysqlConnection>>,
  lessonId: string,
) {
  const [rows] = await connection.execute<ParentCourseRow[]>(
    `
      SELECT parent.id, parent.type, parent.fields, parent.createdAt, directLink.position
      FROM egghead_ContentResourceResource directLink
      JOIN egghead_ContentResource parent
        ON parent.id = directLink.resourceOfId
       AND parent.deletedAt IS NULL
       ${publishedResourceSql("parent")}
      WHERE directLink.resourceId = ?
        AND ${courseResourceCondition("parent")}

      UNION ALL

      SELECT parent.id, parent.type, parent.fields, parent.createdAt, sectionLink.position
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
      WHERE lessonLink.resourceId = ?
        AND section.type = 'section'
        AND ${courseResourceCondition("parent")}

      ORDER BY position ASC, createdAt DESC
      LIMIT 1
    `,
    [lessonId, lessonId],
  );

  return rows[0] ?? null;
}

async function hasExistingParentCourseEvidence(
  connection: Connection,
  lessonId: string,
): Promise<boolean> {
  // Publication and slug filters belong to routing, not authorization. A broken
  // parent link is unresolved evidence, never proof that a lesson is standalone.
  const [rows] = await connection.execute<(RowDataPacket & { hasParent: number })[]>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM egghead_ContentResourceResource link
        LEFT JOIN egghead_ContentResource parent ON parent.id = link.resourceOfId
        WHERE link.resourceId = ?
          AND (
            parent.id IS NULL
            OR ${courseResourceCondition("parent")}
            OR parent.type = 'section'
          )
      ) AS hasParent
    `,
    [lessonId],
  );
  return Number(rows[0]?.hasParent) === 1;
}

async function videoResourceForLesson(
  connection: Awaited<ReturnType<typeof createLocalMysqlConnection>>,
  lessonId: string,
) {
  const [rows] = await connection.execute<VideoResourceRow[]>(
    `
      SELECT video.id, video.type, video.fields, video.createdAt, link.position
      FROM egghead_ContentResourceResource link
      JOIN egghead_ContentResource video
        ON video.id = link.resourceId
       AND video.deletedAt IS NULL
      WHERE link.resourceOfId = ?
        AND video.type = 'videoResource'
      ORDER BY link.position ASC
      LIMIT 1
    `,
    [lessonId],
  );

  return rows[0] ?? null;
}

async function sameSlugRailsTruthFreeForever(
  connection: Awaited<ReturnType<typeof createLocalMysqlConnection>>,
  input: {
    lessonId: string;
    slug: string;
  },
): Promise<boolean | null> {
  const [rows] = await connection.execute<SameSlugRailsTruthRow[]>(
    `
      SELECT
        SUM(
          CASE
            WHEN (
              JSON_TYPE(JSON_EXTRACT(sameSlug.fields, '$.isProContent')) = 'BOOLEAN'
              AND JSON_EXTRACT(sameSlug.fields, '$.isProContent') = CAST('false' AS JSON)
            )
            OR (
              JSON_TYPE(JSON_EXTRACT(sameSlug.fields, '$.is_pro_content')) = 'BOOLEAN'
              AND JSON_EXTRACT(sameSlug.fields, '$.is_pro_content') = CAST('false' AS JSON)
            )
            THEN 1
            ELSE 0
          END
        ) AS freeRows,
        SUM(
          CASE
            WHEN (
              JSON_TYPE(JSON_EXTRACT(sameSlug.fields, '$.isProContent')) = 'BOOLEAN'
              AND JSON_EXTRACT(sameSlug.fields, '$.isProContent') = CAST('true' AS JSON)
            )
            OR (
              JSON_TYPE(JSON_EXTRACT(sameSlug.fields, '$.is_pro_content')) = 'BOOLEAN'
              AND JSON_EXTRACT(sameSlug.fields, '$.is_pro_content') = CAST('true' AS JSON)
            )
            THEN 1
            ELSE 0
          END
        ) AS proRows
      FROM egghead_ContentResource sameSlug
      WHERE sameSlug.deletedAt IS NULL
        ${routeableLessonResourceSql("sameSlug")}
        AND ${lessonResourceCondition("sameSlug")}
        AND JSON_UNQUOTE(JSON_EXTRACT(sameSlug.fields, '$.slug')) = ?
        AND sameSlug.id != ?
    `,
    [input.slug, input.lessonId],
  );
  const row = rows[0];
  const freeRows = Number(row?.freeRows ?? 0);
  const proRows = Number(row?.proRows ?? 0);

  if (proRows > 0) return false;
  if (freeRows > 0) return true;

  return null;
}

function lessonPlaybackFromRows(
  lesson: ContentResourceRow,
  videoResource: VideoResourceRow | null,
) {
  const fields = fieldsFromJson(lesson.fields);
  const videoFields = videoResource ? fieldsFromJson(videoResource.fields) : {};
  const muxPlaybackId =
    stringField(fields, "muxPlaybackId") ?? stringField(videoFields, "muxPlaybackId");
  const videoHlsUrl =
    stringField(fields, "currentVideoHlsUrl") ??
    stringField(videoFields, "currentVideoHlsUrl") ??
    stringField(videoFields, "hlsUrl") ??
    stringField(fields, "videoUrl") ??
    stringField(videoFields, "videoUrl") ??
    stringField(videoFields, "url") ??
    (muxPlaybackId ? `https://stream.mux.com/${muxPlaybackId}.m3u8` : null);
  const videoDashUrl =
    stringField(fields, "currentVideoDashUrl") ?? stringField(videoFields, "currentVideoDashUrl");
  const fallbackPosterUrl =
    stringField(fields, "thumbnailUrl") ??
    stringField(videoFields, "thumbnailUrl") ??
    stringField(fields, "thumbUrl") ??
    stringField(videoFields, "thumbUrl") ??
    stringField(fields, "imageUrl") ??
    stringField(videoFields, "imageUrl") ??
    stringField(fields, "ogImage") ??
    stringField(videoFields, "ogImage");
  return {
    videoHlsUrl,
    videoDashUrl,
    videoPosterUrl: muxThumbnailUrl(muxPlaybackId) ?? fallbackPosterUrl,
    videoResourceId: videoResource?.id ?? null,
    videoMuxPlaybackId: muxPlaybackId,
  };
}

async function readLessonPlaybackById(id: string) {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-content");
  cacheTag(`egghead-lesson-id:${id}`);
  const connection = await createLocalMysqlConnection();
  try {
    const [rows] = await connection.execute<ContentResourceRow[]>(
      `SELECT lesson.id, lesson.type, lesson.fields, lesson.createdAt, lesson.updatedAt
       FROM egghead_ContentResource lesson
       WHERE lesson.id = ? AND lesson.deletedAt IS NULL
         ${routeableLessonResourceSql("lesson")}
         AND ${lessonResourceCondition("lesson")}
       LIMIT 1`,
      [id],
    );
    const lesson = rows[0];
    if (!lesson) return null;
    return lessonPlaybackFromRows(lesson, await videoResourceForLesson(connection, id));
  } finally {
    await connection.end();
  }
}

/** Keep playback entirely out of public page/cache/RSC props, including while
 * access is pending. Denied reads never even load the playback projection. */
export async function getLessonPlaybackForAccess(lessonId: string, accessGranted: boolean) {
  return accessGranted ? readLessonPlaybackById(lessonId) : null;
}

export function lessonForPageFromRows(input: {
  freeForeverOverride?: boolean | null;
  hasParentCourseEvidence: boolean;
  lesson: Pick<ContentResourceRow, "id" | "fields">;
  parentCourse: Pick<ParentCourseRow, "id" | "fields"> | null;
  requestedSlug: string;
  videoResource: Pick<VideoResourceRow, "id" | "fields"> | null;
}): LessonForPage {
  const fields = fieldsFromJson(input.lesson.fields);
  const parentCourseFields = input.parentCourse ? fieldsFromJson(input.parentCourse.fields) : {};
  const videoFields = input.videoResource ? fieldsFromJson(input.videoResource.fields) : {};
  const slug = stringField(fields, "slug") ?? input.requestedSlug;
  const parentCourseSlug = stringField(parentCourseFields, "slug");
  const canonicalPath = parentCourseSlug
    ? collectionEntryPath(parentCourseSlug, slug)
    : standaloneContentPath(slug);

  return {
    id: input.lesson.id,
    title: stringField(fields, "title") ?? "Untitled lesson",
    slug,
    description: excerptField(fields),
    body: markdownField(fields),
    duration: numberField(fields, "duration") ?? numberField(videoFields, "duration"),
    ...lessonAccessFromFields(fields, input),
    parentCourseId: input.parentCourse?.id ?? null,
    parentCourseSlug,
    parentCourseTitle: stringField(parentCourseFields, "title"),
    parentCourseLegacyRailsPlaylistId: numberField(parentCourseFields, "legacyRailsPlaylistId"),
    canonicalPath,
    legacyPath: legacyLessonPath(slug),
    hasTranscript:
      booleanField(fields, "hasTranscript") ||
      booleanField(fields, "transcriptSourceAvailable") ||
      Boolean(stringField(fields, "transcript")) ||
      Boolean(stringField(videoFields, "transcript")),
    hasSrt:
      booleanField(fields, "hasSrt") ||
      booleanField(fields, "srtSourceAvailable") ||
      Boolean(stringField(fields, "srt")) ||
      Boolean(stringField(videoFields, "srt")),
    state: stringField(fields, "state"),
    visibilityState: stringField(fields, "visibilityState"),
    hasVideo: Boolean(
      stringField(fields, "muxPlaybackId") ||
      stringField(videoFields, "muxPlaybackId") ||
      stringField(fields, "currentVideoHlsUrl") ||
      stringField(videoFields, "currentVideoHlsUrl") ||
      stringField(videoFields, "hlsUrl") ||
      stringField(fields, "videoUrl") ||
      stringField(videoFields, "videoUrl") ||
      stringField(videoFields, "url") ||
      stringField(fields, "currentVideoDashUrl") ||
      stringField(videoFields, "currentVideoDashUrl"),
    ),
  };
}

async function getLessonByWhereClause(input: {
  connection?: Awaited<ReturnType<typeof createLocalMysqlConnection>>;
  params: string[];
  requestedSlug: string;
  whereClause: string;
}): Promise<LessonForPage | null> {
  const connection = input.connection ?? (await createLocalMysqlConnection());
  const shouldCloseConnection = !input.connection;

  try {
    const [lessonRows] = await connection.execute<ContentResourceRow[]>(
      `
        SELECT lesson.id, lesson.type, lesson.fields, lesson.createdAt, lesson.updatedAt
        FROM egghead_ContentResource lesson
        WHERE lesson.deletedAt IS NULL
          ${routeableLessonResourceSql("lesson")}
          AND ${lessonResourceCondition("lesson")}
          AND ${input.whereClause}
        ORDER BY
          ${canonicalLessonOrderSql("lesson")}
        LIMIT 1
      `,
      input.params,
    );
    const lesson = lessonRows[0];
    if (!lesson) return null;

    const parentCourse = await parentCoursesForLesson(connection, lesson.id);
    const hasParentCourseEvidence =
      parentCourse !== null || (await hasExistingParentCourseEvidence(connection, lesson.id));
    const fields = fieldsFromJson(lesson.fields);
    const slug = stringField(fields, "slug") ?? input.requestedSlug;
    const freeForeverOverride = !lessonHasRailsProContentSignal(fields)
      ? await sameSlugRailsTruthFreeForever(connection, { lessonId: lesson.id, slug })
      : null;
    const videoResource = await videoResourceForLesson(connection, lesson.id);

    return lessonForPageFromRows({
      freeForeverOverride,
      hasParentCourseEvidence,
      lesson,
      parentCourse,
      requestedSlug: input.requestedSlug,
      videoResource,
    });
  } finally {
    if (shouldCloseConnection) await connection.end();
  }
}

export async function getLessonById(id: string): Promise<LessonForPage | null> {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-content");
  cacheTag(`egghead-lesson-id:${id}`);

  return getLessonByWhereClause({
    params: [id],
    requestedSlug: id,
    whereClause: "lesson.id = ?",
  });
}

export async function getLessonBySlug(slug: string): Promise<LessonForPage | null> {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-content");
  cacheTag(`egghead-lesson:${slug}`);

  const connection = await createLocalMysqlConnection();

  try {
    const lessonSlugSql = await contentResourceSlugSql(connection, "lesson");

    return await getLessonByWhereClause({
      connection,
      params: [slug],
      requestedSlug: slug,
      whereClause: `${lessonSlugSql} = ?`,
    });
  } finally {
    await connection.end();
  }
}

export async function getLessonStaticParams() {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-lesson-static-params");

  const connection = await createLocalMysqlConnection();

  try {
    const lessonSlugSql = await contentResourceSlugSql(connection, "lesson");
    const [rows] = await connection.query<LessonStaticParamRow[]>(
      `
        WITH hot_lessons AS (
          ${hotLessonStaticParamSql()}
        )
        SELECT lesson_slug.slug
        FROM (
          SELECT
            ${lessonSlugSql} AS slug,
            lesson.createdAt,
            hot_lessons.popularityRank,
            hot_lessons.requests720h
          FROM egghead_ContentResource lesson
          LEFT JOIN hot_lessons
            ON hot_lessons.slug = ${lessonSlugSql}
          WHERE lesson.deletedAt IS NULL
            ${routeableLessonResourceSql("lesson")}
            AND ${lessonSlugSql} IS NOT NULL
            AND ${lessonSlugSql} != ''
            AND ${lessonResourceCondition("lesson")}
        ) lesson_slug
        GROUP BY lesson_slug.slug
        ORDER BY
          CASE WHEN MIN(lesson_slug.popularityRank) IS NULL THEN 1 ELSE 0 END ASC,
          MIN(lesson_slug.popularityRank) ASC,
          MAX(lesson_slug.requests720h) DESC,
          MAX(lesson_slug.createdAt) DESC
        LIMIT ${LESSON_STATIC_PARAM_LIMIT}
      `,
    );

    return rows.map((row) => ({ slug: row.slug }));
  } finally {
    await connection.end();
  }
}

export async function getStandaloneLessonStaticParams() {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-standalone-lesson-static-params");

  const connection = await createLocalMysqlConnection();

  try {
    const lessonSlugSql = await contentResourceSlugSql(connection, "lesson");
    const sameSlugLessonSlugSql = await contentResourceSlugSql(connection, "sameSlugLesson");
    const [rows] = await connection.query<LessonStaticParamRow[]>(
      `
        SELECT lesson_slug.slug
        FROM (
          SELECT
            ${lessonSlugSql} AS slug,
            lesson.createdAt
          FROM egghead_ContentResource lesson
          WHERE lesson.deletedAt IS NULL
            ${routeableLessonResourceSql("lesson")}
            AND ${lessonSlugSql} IS NOT NULL
            AND ${lessonSlugSql} != ''
            AND ${lessonResourceCondition("lesson")}
        ) lesson_slug
        WHERE NOT EXISTS (
          SELECT 1
          FROM egghead_ContentResource sameSlugLesson
          JOIN egghead_ContentResourceResource directLink
            ON directLink.resourceId = sameSlugLesson.id
          JOIN egghead_ContentResource parent
            ON parent.id = directLink.resourceOfId
           AND parent.deletedAt IS NULL
           ${publishedResourceSql("parent")}
          WHERE sameSlugLesson.deletedAt IS NULL
            ${routeableLessonResourceSql("sameSlugLesson")}
            AND ${lessonResourceCondition("sameSlugLesson")}
            AND ${sameSlugLessonSlugSql} = lesson_slug.slug
            AND ${courseResourceCondition("parent")}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM egghead_ContentResource sameSlugLesson
          JOIN egghead_ContentResourceResource lessonLink
            ON lessonLink.resourceId = sameSlugLesson.id
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
          WHERE sameSlugLesson.deletedAt IS NULL
            ${routeableLessonResourceSql("sameSlugLesson")}
            AND ${lessonResourceCondition("sameSlugLesson")}
            AND ${sameSlugLessonSlugSql} = lesson_slug.slug
            AND section.type = 'section'
            AND ${courseResourceCondition("parent")}
        )
        GROUP BY lesson_slug.slug
        ORDER BY MAX(lesson_slug.createdAt) DESC
        LIMIT ${LESSON_STATIC_PARAM_LIMIT}
      `,
    );

    return rows.map((row) => ({ slug: row.slug }));
  } finally {
    await connection.end();
  }
}
