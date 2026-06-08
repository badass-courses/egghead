import type { RowDataPacket } from "mysql2";
import { cacheLife, cacheTag } from "next/cache";

import { createLocalMysqlConnection } from "../db/local-docker";
import { booleanField, fieldsFromJson, numberField, stringField } from "./fields";

type ContentResourceRow = RowDataPacket & {
  id: string;
  type: string;
  fields: unknown;
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
  parentCourseLegacyRailsPlaylistId: number | null;
  hasTranscript: boolean;
  hasSrt: boolean;
  state: string | null;
  visibilityState: string | null;
  videoHlsUrl: string | null;
  videoDashUrl: string | null;
  videoResourceId: string | null;
  videoMuxPlaybackId: string | null;
};

export async function getLessonBySlug(slug: string): Promise<LessonForPage | null> {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-content");
  cacheTag(`egghead-lesson:${slug}`);

  const connection = await createLocalMysqlConnection();

  try {
    const [lessonRows] = await connection.execute<ContentResourceRow[]>(
      `
        SELECT id, type, fields
        FROM egghead_ContentResource
        WHERE deletedAt IS NULL
          AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.slug')) = ?
          AND (
            type = 'lesson'
            OR (
              type = 'post'
              AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.postType')) = 'lesson'
            )
          )
        LIMIT 1
      `,
      [slug],
    );
    const lesson = lessonRows[0];
    if (!lesson) return null;

    const [parentCourseRows] = await connection.execute<ParentCourseRow[]>(
      `
        SELECT parent.id, parent.type, parent.fields, link.position
        FROM egghead_ContentResourceResource link
        JOIN egghead_ContentResource parent
          ON parent.id = link.resourceOfId
         AND parent.deletedAt IS NULL
        WHERE link.resourceId = ?
          AND (
            parent.type = 'course'
            OR JSON_UNQUOTE(JSON_EXTRACT(parent.fields, '$.postType')) = 'course'
          )
        ORDER BY link.position ASC
        LIMIT 1
      `,
      [lesson.id],
    );
    const [videoRows] = await connection.execute<VideoResourceRow[]>(
      `
        SELECT video.id, video.type, video.fields, link.position
        FROM egghead_ContentResourceResource link
        JOIN egghead_ContentResource video
          ON video.id = link.resourceId
         AND video.deletedAt IS NULL
        WHERE link.resourceOfId = ?
          AND video.type = 'videoResource'
        ORDER BY link.position ASC
        LIMIT 1
      `,
      [lesson.id],
    );
    const fields = fieldsFromJson(lesson.fields);
    const parentCourse = parentCourseRows[0] ?? null;
    const parentCourseFields = parentCourse ? fieldsFromJson(parentCourse.fields) : {};
    const videoFields = videoRows[0] ? fieldsFromJson(videoRows[0].fields) : {};
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

    return {
      id: lesson.id,
      title: stringField(fields, "title") ?? "Untitled lesson",
      slug: stringField(fields, "slug") ?? slug,
      description: stringField(fields, "description") ?? stringField(fields, "summary") ?? "",
      body: stringField(fields, "body"),
      duration: numberField(fields, "duration") ?? numberField(videoFields, "duration"),
      freeForever: booleanField(fields, "freeForever"),
      isProContent: booleanField(fields, "isProContent"),
      courseLinked: Boolean(parentCourse),
      parentCourseId: parentCourse?.id ?? null,
      parentCourseLegacyRailsPlaylistId: numberField(parentCourseFields, "legacyRailsPlaylistId"),
      hasTranscript: booleanField(fields, "hasTranscript"),
      hasSrt: booleanField(fields, "hasSrt"),
      state: stringField(fields, "state"),
      visibilityState: stringField(fields, "visibilityState"),
      videoHlsUrl,
      videoDashUrl,
      videoResourceId: videoRows[0]?.id ?? null,
      videoMuxPlaybackId: muxPlaybackId,
    };
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
    const [rows] = await connection.execute<Array<RowDataPacket & { slug: string }>>(
      `
        SELECT lesson_slug.slug
        FROM (
          SELECT
            JSON_UNQUOTE(JSON_EXTRACT(fields, '$.slug')) AS slug,
            createdAt
          FROM egghead_ContentResource
          WHERE deletedAt IS NULL
            AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.slug')) IS NOT NULL
            AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.slug')) != ''
            AND (
              type = 'lesson'
              OR (
                type = 'post'
                AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.postType')) = 'lesson'
              )
            )
        ) lesson_slug
        GROUP BY lesson_slug.slug
        ORDER BY MAX(lesson_slug.createdAt) DESC
      `,
    );

    return rows.map((row) => ({ slug: row.slug }));
  } finally {
    await connection.end();
  }
}
