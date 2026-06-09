import type { RowDataPacket } from "mysql2";
import { cacheLife, cacheTag } from "next/cache";

import { createLocalMysqlConnection } from "../db/local-docker";
import {
  booleanField,
  excerptField,
  fieldsFromJson,
  markdownField,
  numberField,
  objectField,
  stringField,
} from "./fields";
import {
  LESSON_STATIC_PARAM_LIMIT,
  publishedResourceSql,
  routeableLessonResourceSql,
} from "./publication";
import { contentResourceSlugSql } from "./resource-slug";
import { HOT_LESSON_STATIC_PARAMS } from "./hot-lesson-static-params";
import { collectionEntryPath, collectionPath, legacyCoursePath } from "./routes";

type ContentResourceRow = RowDataPacket & {
  id: string;
  type: string;
  fields: unknown;
  createdAt: Date;
  updatedAt: Date;
};

type LinkedResourceRow = ContentResourceRow & {
  position: number;
  resourceKind: "lesson" | "section";
  sectionId: string | null;
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
  sectionId: string | null;
  canonicalPath: string;
};

export type CourseSection = {
  id: string;
  title: string;
  position: number;
  lessons: CourseLesson[];
};

export type CourseForPage = {
  id: string;
  title: string;
  slug: string;
  description: string;
  body: string | null;
  state: string | null;
  visibilityState: string | null;
  accessState: string | null;
  instructorName: string | null;
  legacyRailsPlaylistId: number | null;
  lessonCount: number;
  canonicalPath: string;
  legacyPath: string;
  lessons: CourseLesson[];
  sections: CourseSection[];
};

type CourseLessonStaticParamRow = RowDataPacket & {
  collection: string;
  entry: string;
};

export const COURSE_LESSON_STATIC_PARAM_LIMIT = LESSON_STATIC_PARAM_LIMIT;

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

function instructorName(fields: Record<string, unknown>): string | null {
  const instructor = objectField(fields, "instructor");
  return instructor ? stringField(instructor, "name") : null;
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

function toLesson(row: LinkedResourceRow, courseSlug: string): CourseLesson | null {
  const fields = fieldsFromJson(row.fields);
  const slug = stringField(fields, "slug");

  if (!slug) return null;

  return {
    id: row.id,
    title: stringField(fields, "title") ?? "Untitled lesson",
    slug,
    description: excerptField(fields),
    duration: numberField(fields, "duration"),
    position: row.position,
    freeForever: booleanField(fields, "freeForever"),
    isProContent: booleanField(fields, "isProContent"),
    sectionId: row.sectionId,
    canonicalPath: collectionEntryPath(courseSlug, slug),
  };
}

function sectionFromRow(row: LinkedResourceRow): CourseSection {
  const fields = fieldsFromJson(row.fields);

  return {
    id: row.id,
    title: stringField(fields, "title") ?? "Untitled section",
    position: row.position,
    lessons: [],
  };
}

function sortByPosition<T extends { position: number; id: string }>(items: T[]) {
  return items.toSorted(
    (left, right) => left.position - right.position || left.id.localeCompare(right.id),
  );
}

function sectionPlaceholders(rows: CourseSection[]) {
  return rows.map(() => "?").join(", ");
}

async function getNestedLessonsForSections(
  connection: Awaited<ReturnType<typeof createLocalMysqlConnection>>,
  sections: CourseSection[],
): Promise<LinkedResourceRow[]> {
  if (sections.length === 0) return [];

  const [rows] = await connection.execute<LinkedResourceRow[]>(
    `
      SELECT
        lesson.id,
        lesson.type,
        lesson.fields,
        lesson.createdAt,
        lesson.updatedAt,
        childLink.position,
        'lesson' AS resourceKind,
        childLink.resourceOfId AS sectionId
      FROM egghead_ContentResourceResource childLink
      JOIN egghead_ContentResource lesson
        ON lesson.id = childLink.resourceId
       AND lesson.deletedAt IS NULL
       ${routeableLessonResourceSql("lesson")}
      WHERE childLink.resourceOfId IN (${sectionPlaceholders(sections)})
        AND ${lessonResourceCondition("lesson")}
      ORDER BY childLink.position ASC, lesson.createdAt ASC
    `,
    sections.map((section) => section.id),
  );

  return rows;
}

export async function getCourseBySlug(slug: string): Promise<CourseForPage | null> {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-content");
  cacheTag(`egghead-course:${slug}`);

  const connection = await createLocalMysqlConnection();

  try {
    const courseSlugSql = await contentResourceSlugSql(connection, "course");
    const [courseRows] = await connection.execute<ContentResourceRow[]>(
      `
        SELECT course.id, course.type, course.fields, course.createdAt, course.updatedAt
        FROM egghead_ContentResource course
        WHERE course.deletedAt IS NULL
          ${publishedResourceSql("course")}
          AND ${courseSlugSql} = ?
          AND ${courseResourceCondition("course")}
        ORDER BY course.createdAt DESC
        LIMIT 1
      `,
      [slug],
    );
    const course = courseRows[0];
    if (!course) return null;

    const [resourceRows] = await connection.execute<LinkedResourceRow[]>(
      `
        SELECT
          resource.id,
          resource.type,
          resource.fields,
          resource.createdAt,
          resource.updatedAt,
          link.position,
          CASE WHEN resource.type = 'section' THEN 'section' ELSE 'lesson' END AS resourceKind,
          NULL AS sectionId
        FROM egghead_ContentResourceResource link
        JOIN egghead_ContentResource resource
          ON resource.id = link.resourceId
         AND resource.deletedAt IS NULL
        WHERE link.resourceOfId = ?
          AND (
            (
              resource.type = 'section'
              ${publishedResourceSql("resource")}
            )
            OR (
              ${lessonResourceCondition("resource")}
              ${routeableLessonResourceSql("resource")}
            )
          )
        ORDER BY link.position ASC, resource.createdAt ASC
      `,
      [course.id],
    );

    const fields = fieldsFromJson(course.fields);
    const courseSlug = stringField(fields, "slug") ?? slug;
    const sections = sortByPosition(
      resourceRows.filter((row) => row.resourceKind === "section").map(sectionFromRow),
    );
    const nestedLessons = await getNestedLessonsForSections(connection, sections);
    const directLessons = resourceRows.filter((row) => row.resourceKind === "lesson");
    const lessons = sortByPosition(
      [...directLessons, ...nestedLessons]
        .map((row) => toLesson(row, courseSlug))
        .filter((lesson): lesson is CourseLesson => lesson !== null),
    );
    const sectionsById = new Map(sections.map((section) => [section.id, section]));

    for (const lesson of lessons) {
      if (!lesson.sectionId) continue;

      const section = sectionsById.get(lesson.sectionId);
      if (section) section.lessons.push(lesson);
    }

    return {
      id: course.id,
      title: stringField(fields, "title") ?? "Untitled course",
      slug: courseSlug,
      description: excerptField(fields),
      body: markdownField(fields),
      state: stringField(fields, "state"),
      visibilityState: stringField(fields, "visibilityState"),
      accessState: stringField(fields, "accessState"),
      instructorName: instructorName(fields),
      legacyRailsPlaylistId: numberField(fields, "legacyRailsPlaylistId"),
      lessonCount: numberField(fields, "lessonCount") ?? lessons.length,
      canonicalPath: collectionPath(courseSlug),
      legacyPath: legacyCoursePath(courseSlug),
      lessons,
      sections,
    };
  } finally {
    await connection.end();
  }
}

export function getCourseLesson(course: CourseForPage, lessonSlug: string) {
  return course.lessons.find((lesson) => lesson.slug === lessonSlug) ?? null;
}

export async function getCourseStaticParams() {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-course-static-params");

  const connection = await createLocalMysqlConnection();

  try {
    const courseSlugSql = await contentResourceSlugSql(connection, "course");
    const [rows] = await connection.execute<Array<RowDataPacket & { slug: string }>>(
      `
        SELECT course_slug.slug
        FROM (
          SELECT
            ${courseSlugSql} AS slug,
            course.createdAt
          FROM egghead_ContentResource course
          WHERE course.deletedAt IS NULL
            ${publishedResourceSql("course")}
            AND ${courseSlugSql} IS NOT NULL
            AND ${courseSlugSql} != ''
            AND ${courseResourceCondition("course")}
        ) course_slug
        GROUP BY course_slug.slug
        ORDER BY MAX(course_slug.createdAt) DESC
      `,
    );

    return rows.map((row) => ({ slug: row.slug }));
  } finally {
    await connection.end();
  }
}

export async function getCourseLessonStaticParams() {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-course-lesson-static-params");

  const connection = await createLocalMysqlConnection();

  try {
    const courseSlugSql = await contentResourceSlugSql(connection, "course");
    const lessonSlugSql = await contentResourceSlugSql(connection, "lesson");
    const [rows] = await connection.query<CourseLessonStaticParamRow[]>(
      `
        WITH hot_lessons AS (
          ${hotLessonStaticParamSql()}
        )
        SELECT route.collection, route.entry
        FROM (
          SELECT
            ${courseSlugSql} AS collection,
            ${lessonSlugSql} AS entry,
            lesson.createdAt
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

          UNION ALL

          SELECT
            ${courseSlugSql} AS collection,
            ${lessonSlugSql} AS entry,
            lesson.createdAt
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
        ) route
        LEFT JOIN hot_lessons
          ON hot_lessons.slug = route.entry
        WHERE route.collection IS NOT NULL
          AND route.collection != ''
          AND route.entry IS NOT NULL
          AND route.entry != ''
        GROUP BY route.collection, route.entry
        ORDER BY
          CASE WHEN MIN(hot_lessons.popularityRank) IS NULL THEN 1 ELSE 0 END ASC,
          MIN(hot_lessons.popularityRank) ASC,
          MAX(hot_lessons.requests720h) DESC,
          MAX(route.createdAt) DESC
        LIMIT ${COURSE_LESSON_STATIC_PARAM_LIMIT}
      `,
    );

    return rows.map((row) => ({
      collection: row.collection,
      entry: row.entry,
    }));
  } finally {
    await connection.end();
  }
}
