import type { RowDataPacket } from "mysql2";
import { cacheLife, cacheTag } from "next/cache";

import { createLocalMysqlConnection } from "../db/local-docker";

type TranscriptRow = RowDataPacket & {
  transcript: string | null;
};

/* Transcripts are not stored on the lesson itself — they live on the
   associated videoResource's `fields.transcript` (written by the
   Deepgram pipeline). Mirrors ai-hero's getLessonVideoTranscript: join
   lesson -> videoResource and read the transcript. Returns null when the
   video has no transcript yet. */
export async function getLessonVideoTranscript(lessonId: string): Promise<string | null> {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-content");
  cacheTag(`egghead-transcript:${lessonId}`);

  const connection = await createLocalMysqlConnection();

  try {
    const [rows] = await connection.execute<TranscriptRow[]>(
      `
        SELECT video.fields->>'$.transcript' AS transcript
        FROM egghead_ContentResource lesson
        JOIN egghead_ContentResourceResource link ON link.resourceOfId = lesson.id
        JOIN egghead_ContentResource video
          ON video.id = link.resourceId
         AND video.type = 'videoResource'
         AND video.deletedAt IS NULL
        WHERE lesson.id = ?
          AND video.fields->>'$.transcript' IS NOT NULL
        ORDER BY link.position ASC
        LIMIT 1
      `,
      [lessonId],
    );

    return rows[0]?.transcript ?? null;
  } finally {
    await connection.end();
  }
}
