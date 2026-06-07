import { cache } from "react";
import type { RowDataPacket } from "mysql2";

import { createLocalMysqlConnection } from "../db/local-docker";
import { booleanField, fieldsFromJson, numberField, stringField } from "./fields";

type ContentResourceRow = RowDataPacket & {
  id: string;
  type: string;
  fields: unknown;
};

export type LessonForPage = {
  id: string;
  title: string;
  slug: string;
  description: string;
  duration: number | null;
  freeForever: boolean;
  isProContent: boolean;
  hasTranscript: boolean;
  hasSrt: boolean;
  state: string | null;
  visibilityState: string | null;
  videoHlsUrl: string | null;
  videoDashUrl: string | null;
};

export const getLessonBySlug = cache(async (slug: string): Promise<LessonForPage | null> => {
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

    const fields = fieldsFromJson(lesson.fields);

    return {
      id: lesson.id,
      title: stringField(fields, "title") ?? "Untitled lesson",
      slug: stringField(fields, "slug") ?? slug,
      description: stringField(fields, "description") ?? stringField(fields, "summary") ?? "",
      duration: numberField(fields, "duration"),
      freeForever: booleanField(fields, "freeForever"),
      isProContent: booleanField(fields, "isProContent"),
      hasTranscript: booleanField(fields, "hasTranscript"),
      hasSrt: booleanField(fields, "hasSrt"),
      state: stringField(fields, "state"),
      visibilityState: stringField(fields, "visibilityState"),
      videoHlsUrl: stringField(fields, "currentVideoHlsUrl"),
      videoDashUrl: stringField(fields, "currentVideoDashUrl"),
    };
  } finally {
    await connection.end();
  }
});
