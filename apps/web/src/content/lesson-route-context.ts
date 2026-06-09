import type { RowDataPacket } from "mysql2";

import { createLocalMysqlConnection } from "../db/local-docker";
import { publishedResourceSql } from "./publication";
import { collectionEntryPath, standaloneContentPath } from "./routes";

type MysqlConnection = Awaited<ReturnType<typeof createLocalMysqlConnection>>;

type ParentCourseSlugRow = RowDataPacket & {
  lessonId: string;
  courseId: string;
  courseSlug: string | null;
  position: number | string | null;
  createdAt: Date | string | null;
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

export async function parentCourseSlugsForLessonIds(
  connection: MysqlConnection,
  lessonIds: readonly string[],
): Promise<Map<string, string>> {
  const uniqueLessonIds = [...new Set(lessonIds.filter(Boolean))];
  const result = new Map<string, string>();

  if (uniqueLessonIds.length === 0) return result;

  const lessonPlaceholders = placeholders(uniqueLessonIds);
  const [rows] = await connection.execute<ParentCourseSlugRow[]>(
    `
      SELECT route.lessonId, route.courseId, route.courseSlug, route.position, route.createdAt
      FROM (
        SELECT
          directLink.resourceId AS lessonId,
          parent.id AS courseId,
          JSON_UNQUOTE(JSON_EXTRACT(parent.fields, '$.slug')) AS courseSlug,
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
    if (!result.has(row.lessonId) && row.courseSlug) {
      result.set(row.lessonId, row.courseSlug);
    }
  }

  return result;
}
