import type { RowDataPacket } from "mysql2";
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
  videoHlsUrl: string | null;
  videoDashUrl: string | null;
  videoResourceId: string | null;
  videoMuxPlaybackId: string | null;
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

function lessonFromRows(input: {
  lesson: ContentResourceRow;
  parentCourse: ParentCourseRow | null;
  requestedSlug: string;
  videoResource: VideoResourceRow | null;
}): LessonForPage {
  const fields = fieldsFromJson(input.lesson.fields);
  const parentCourseFields = input.parentCourse ? fieldsFromJson(input.parentCourse.fields) : {};
  const videoFields = input.videoResource ? fieldsFromJson(input.videoResource.fields) : {};
  const slug = stringField(fields, "slug") ?? input.requestedSlug;
  const parentCourseSlug = stringField(parentCourseFields, "slug");
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
    freeForever: booleanField(fields, "freeForever"),
    isProContent: booleanField(fields, "isProContent"),
    courseLinked: Boolean(parentCourseSlug),
    parentCourseId: input.parentCourse?.id ?? null,
    parentCourseSlug,
    parentCourseTitle: stringField(parentCourseFields, "title"),
    parentCourseLegacyRailsPlaylistId: numberField(parentCourseFields, "legacyRailsPlaylistId"),
    canonicalPath,
    legacyPath: legacyLessonPath(slug),
    hasTranscript:
      booleanField(fields, "hasTranscript") ||
      booleanField(fields, "transcriptSourceAvailable") ||
      Boolean(stringField(fields, "transcript")),
    hasSrt:
      booleanField(fields, "hasSrt") ||
      booleanField(fields, "srtSourceAvailable") ||
      Boolean(stringField(fields, "srt")),
    state: stringField(fields, "state"),
    visibilityState: stringField(fields, "visibilityState"),
    videoHlsUrl,
    videoDashUrl,
    videoResourceId: input.videoResource?.id ?? null,
    videoMuxPlaybackId: muxPlaybackId,
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
          CASE LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(lesson.fields, '$.state')), 'published'))
            WHEN 'published' THEN 0
            WHEN 'retired' THEN 1
            ELSE 2
          END,
          lesson.updatedAt DESC,
          lesson.createdAt DESC,
          lesson.id ASC
        LIMIT 1
      `,
      input.params,
    );
    const lesson = lessonRows[0];
    if (!lesson) return null;

    const parentCourse = await parentCoursesForLesson(connection, lesson.id);
    const videoResource = await videoResourceForLesson(connection, lesson.id);

    return lessonFromRows({
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
    const [rows] = await connection.query<LessonStaticParamRow[]>(
      `
        SELECT lesson_slug.slug
        FROM (
          SELECT
            lesson.id,
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
        ORDER BY MAX(lesson_slug.createdAt) DESC
        LIMIT ${LESSON_STATIC_PARAM_LIMIT}
      `,
    );

    return rows.map((row) => ({ slug: row.slug }));
  } finally {
    await connection.end();
  }
}
