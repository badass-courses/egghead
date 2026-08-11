import type { RowDataPacket } from "mysql2";

import { createLocalMysqlConnection } from "../db/local-docker";
import { publishedResourceSql } from "./publication";
import { collectionEntryPath, collectionPath, standaloneContentPath } from "./routes";

type MysqlConnection = Awaited<ReturnType<typeof createLocalMysqlConnection>>;

type ParentCourseRouteContextRow = RowDataPacket & {
  lessonId: string;
  courseId: string;
  courseSlug: string | null;
  courseTitle: string | null;
  position: number | string | null;
  createdAt: Date | string | null;
};

export type ParentCourseRouteContext = {
  title: string;
  slug: string;
  href: string;
};

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

function placeholders(values: readonly unknown[]) {
  return values.map(() => "?").join(", ");
}

export function lessonCanonicalPathForRouteContext(slug: string, parentCourseSlug?: string | null) {
  return parentCourseSlug
    ? collectionEntryPath(parentCourseSlug, slug)
    : standaloneContentPath(slug);
}

export async function parentCourseRouteContextsForLessonIds(
  connection: MysqlConnection,
  lessonIds: readonly string[],
): Promise<Map<string, ParentCourseRouteContext>> {
  const uniqueLessonIds = [...new Set(lessonIds.filter(Boolean))];
  const result = new Map<string, ParentCourseRouteContext>();

  if (uniqueLessonIds.length === 0) return result;

  const lessonPlaceholders = placeholders(uniqueLessonIds);
  const [rows] = await connection.execute<ParentCourseRouteContextRow[]>(
    `
      SELECT
        route.lessonId,
        route.courseId,
        route.courseSlug,
        route.courseTitle,
        route.position,
        route.createdAt
      FROM (
        SELECT
          directLink.resourceId AS lessonId,
          parent.id AS courseId,
          JSON_UNQUOTE(JSON_EXTRACT(parent.fields, '$.slug')) AS courseSlug,
          JSON_UNQUOTE(JSON_EXTRACT(parent.fields, '$.title')) AS courseTitle,
          directLink.position AS position,
          parent.createdAt AS createdAt
        FROM egghead_ContentResourceResource directLink
        JOIN egghead_ContentResource parent
          ON parent.id = directLink.resourceOfId
         AND parent.deletedAt IS NULL
         ${publishedResourceSql("parent")}
        WHERE directLink.resourceId IN (${lessonPlaceholders})
          AND ${courseResourceCondition("parent")}

        UNION ALL

        SELECT
          lessonLink.resourceId AS lessonId,
          parent.id AS courseId,
          JSON_UNQUOTE(JSON_EXTRACT(parent.fields, '$.slug')) AS courseSlug,
          JSON_UNQUOTE(JSON_EXTRACT(parent.fields, '$.title')) AS courseTitle,
          sectionLink.position AS position,
          parent.createdAt AS createdAt
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
        WHERE lessonLink.resourceId IN (${lessonPlaceholders})
          AND section.type = 'section'
          AND ${courseResourceCondition("parent")}
      ) route
      WHERE route.courseSlug IS NOT NULL
        AND route.courseSlug != ''
      ORDER BY route.lessonId ASC, route.position ASC, route.createdAt DESC, route.courseId ASC
    `,
    [...uniqueLessonIds, ...uniqueLessonIds],
  );

  for (const row of rows) {
    if (result.has(row.lessonId) || !row.courseSlug) continue;

    const courseTitle = row.courseTitle?.trim();
    result.set(row.lessonId, {
      title: courseTitle && courseTitle.toLowerCase() !== "null" ? courseTitle : "Untitled course",
      slug: row.courseSlug,
      href: collectionPath(row.courseSlug),
    });
  }

  return result;
}

export async function parentCourseSlugsForLessonIds(
  connection: MysqlConnection,
  lessonIds: readonly string[],
): Promise<Map<string, string>> {
  const contexts = await parentCourseRouteContextsForLessonIds(connection, lessonIds);

  return new Map([...contexts].map(([lessonId, course]) => [lessonId, course.slug]));
}
