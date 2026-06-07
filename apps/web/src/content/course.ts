import type { RowDataPacket } from "mysql2";
import { cacheLife, cacheTag } from "next/cache";

import { createLocalMysqlConnection } from "../db/local-docker";
import { booleanField, fieldsFromJson, numberField, objectField, stringField } from "./fields";

type ContentResourceRow = RowDataPacket & {
  id: string;
  type: string;
  fields: unknown;
  createdAt: Date;
  updatedAt: Date;
};

type LessonResourceRow = ContentResourceRow & {
  position: number;
};

export type CourseLesson = {
  id: string;
  title: string;
  slug: string;
  description: string;
  duration: number | null;
  position: number;
  freeForever: boolean;
  isProContent: boolean;
};

export type CourseForPage = {
  id: string;
  title: string;
  slug: string;
  description: string;
  state: string | null;
  visibilityState: string | null;
  accessState: string | null;
  instructorName: string | null;
  lessonCount: number;
  lessons: CourseLesson[];
};

function instructorName(fields: Record<string, unknown>): string | null {
  const instructor = objectField(fields, "instructor");
  return instructor ? stringField(instructor, "name") : null;
}

function toLesson(row: LessonResourceRow): CourseLesson {
  const fields = fieldsFromJson(row.fields);

  return {
    id: row.id,
    title: stringField(fields, "title") ?? "Untitled lesson",
    slug: stringField(fields, "slug") ?? row.id,
    description: stringField(fields, "description") ?? stringField(fields, "summary") ?? "",
    duration: numberField(fields, "duration"),
    position: row.position,
    freeForever: booleanField(fields, "freeForever"),
    isProContent: booleanField(fields, "isProContent"),
  };
}

export async function getCourseBySlug(slug: string): Promise<CourseForPage | null> {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-content");
  cacheTag(`egghead-course:${slug}`);

  const connection = await createLocalMysqlConnection();

  try {
    const [courseRows] = await connection.execute<ContentResourceRow[]>(
      `
        SELECT id, type, fields, createdAt, updatedAt
        FROM egghead_ContentResource
        WHERE deletedAt IS NULL
          AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.slug')) = ?
          AND (
            type = 'course'
            OR (
              type = 'post'
              AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.postType')) = 'course'
            )
          )
        LIMIT 1
      `,
      [slug],
    );
    const course = courseRows[0];
    if (!course) return null;

    const [lessonRows] = await connection.execute<LessonResourceRow[]>(
      `
        SELECT lesson.id, lesson.type, lesson.fields, lesson.createdAt, lesson.updatedAt, link.position
        FROM egghead_ContentResourceResource link
        JOIN egghead_ContentResource lesson
          ON lesson.id = link.resourceId
         AND lesson.deletedAt IS NULL
        WHERE link.resourceOfId = ?
        ORDER BY link.position ASC, lesson.createdAt ASC
      `,
      [course.id],
    );

    const fields = fieldsFromJson(course.fields);
    const lessons = lessonRows.map(toLesson);

    return {
      id: course.id,
      title: stringField(fields, "title") ?? "Untitled course",
      slug: stringField(fields, "slug") ?? slug,
      description: stringField(fields, "description") ?? stringField(fields, "summary") ?? "",
      state: stringField(fields, "state"),
      visibilityState: stringField(fields, "visibilityState"),
      accessState: stringField(fields, "accessState"),
      instructorName: instructorName(fields),
      lessonCount: numberField(fields, "lessonCount") ?? lessons.length,
      lessons,
    };
  } finally {
    await connection.end();
  }
}

export async function getCourseStaticParams() {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-course-static-params");

  const connection = await createLocalMysqlConnection();

  try {
    const [rows] = await connection.execute<Array<RowDataPacket & { slug: string }>>(
      `
        SELECT JSON_UNQUOTE(JSON_EXTRACT(fields, '$.slug')) AS slug
        FROM egghead_ContentResource
        WHERE deletedAt IS NULL
          AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.slug')) IS NOT NULL
          AND (
            type = 'course'
            OR (
              type = 'post'
              AND JSON_UNQUOTE(JSON_EXTRACT(fields, '$.postType')) = 'course'
            )
          )
        ORDER BY createdAt DESC
      `,
    );

    return rows.map((row) => ({ course: row.slug }));
  } finally {
    await connection.end();
  }
}
