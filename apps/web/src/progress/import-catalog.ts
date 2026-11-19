import type { RowDataPacket } from "mysql2";
import type { Connection } from "mysql2/promise";

import { canonicalLessonOrderSql } from "../content/canonical-order";

type Db = Pick<Connection, "execute">;

// ---------------------------------------------------------------------------
// CB content catalog: Rails lesson and playlist ids → CB resource ids.

export type CbContentCatalog = {
  lessonByRailsId: ReadonlyMap<number, string>;
  /** Only lesson rows without any legacy Rails id, so a slug never steals another lesson's row. */
  lessonBySlug: ReadonlyMap<string, string>;
  courseByRailsPlaylistId: ReadonlyMap<number, string>;
  /** Only course rows without a Rails playlist id, mirroring `lessonBySlug`. */
  courseBySlug: ReadonlyMap<string, string>;
  stats: {
    lessonRows: number;
    lessonRowsWithRailsId: number;
    duplicateLessonRowsForRailsId: number;
    courseRows: number;
    courseRowsWithRailsPlaylistId: number;
  };
};

type CatalogLessonRow = RowDataPacket & {
  id: string;
  legacySourceId: string | null;
  eggheadLessonId: string | null;
  legacyRailsLessonId: string | null;
  slug: string | null;
};

type CatalogCourseRow = RowDataPacket & {
  id: string;
  legacyRailsPlaylistId: string | null;
  slug: string | null;
};

function jsonString(alias: string, key: string) {
  return `JSON_UNQUOTE(JSON_EXTRACT(${alias}.fields, '$.${key}'))`;
}

export function positiveInteger(value: string | number | null | undefined) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * Same precedence as the content migration (`tools/me.ts`,
 * `rowLegacyIdOrSourceId(row, "legacySourceId", "eggheadLessonId", "legacyRailsLessonId")`).
 */
function railsLessonIdForRow(row: CatalogLessonRow) {
  return (
    positiveInteger(row.legacySourceId) ??
    positiveInteger(row.eggheadLessonId) ??
    positiveInteger(row.legacyRailsLessonId)
  );
}

export function normalizeSlug(slug: string | null | undefined) {
  const normalized = slug?.trim().toLowerCase() ?? "";
  return normalized.length > 0 && normalized !== "null" ? normalized : null;
}

/**
 * Loads every live lesson and course once. Duplicate CB rows for one Rails
 * lesson resolve to the row the lesson pages read (`canonicalLessonOrderSql`),
 * so imported completions show where learners look and are counted once.
 */
export async function loadCbContentCatalog(db: Db): Promise<CbContentCatalog> {
  const [lessonRows] = await db.execute<CatalogLessonRow[]>(`
    SELECT
      lesson.id,
      ${jsonString("lesson", "legacySourceId")} AS legacySourceId,
      ${jsonString("lesson", "eggheadLessonId")} AS eggheadLessonId,
      ${jsonString("lesson", "legacyRailsLessonId")} AS legacyRailsLessonId,
      ${jsonString("lesson", "slug")} AS slug
    FROM egghead_ContentResource lesson
    WHERE lesson.deletedAt IS NULL
      AND (
        lesson.type = 'lesson'
        OR (lesson.type = 'post' AND ${jsonString("lesson", "postType")} = 'lesson')
      )
    ORDER BY ${canonicalLessonOrderSql("lesson")}
  `);

  const [courseRows] = await db.execute<CatalogCourseRow[]>(`
    SELECT
      course.id,
      ${jsonString("course", "legacyRailsPlaylistId")} AS legacyRailsPlaylistId,
      ${jsonString("course", "slug")} AS slug
    FROM egghead_ContentResource course
    WHERE course.deletedAt IS NULL
      AND (
        course.type = 'course'
        OR (course.type = 'post' AND ${jsonString("course", "postType")} = 'course')
      )
    ORDER BY
      CASE LOWER(COALESCE(${jsonString("course", "state")}, 'published'))
        WHEN 'published' THEN 0
        WHEN 'retired' THEN 1
        ELSE 2
      END ASC,
      course.updatedAt DESC,
      course.id ASC
  `);

  const lessonByRailsId = new Map<number, string>();
  const lessonBySlug = new Map<string, string>();
  let lessonRowsWithRailsId = 0;
  let duplicateLessonRowsForRailsId = 0;

  // Rows arrive best-first, so the first row per key wins.
  for (const row of lessonRows) {
    const railsLessonId = railsLessonIdForRow(row);
    if (railsLessonId !== null) {
      lessonRowsWithRailsId += 1;
      if (lessonByRailsId.has(railsLessonId)) duplicateLessonRowsForRailsId += 1;
      else lessonByRailsId.set(railsLessonId, row.id);
      continue;
    }

    const slug = normalizeSlug(row.slug);
    if (slug !== null && !lessonBySlug.has(slug)) lessonBySlug.set(slug, row.id);
  }

  const courseByRailsPlaylistId = new Map<number, string>();
  const courseBySlug = new Map<string, string>();
  let courseRowsWithRailsPlaylistId = 0;

  for (const row of courseRows) {
    const playlistId = positiveInteger(row.legacyRailsPlaylistId);
    if (playlistId !== null) {
      courseRowsWithRailsPlaylistId += 1;
      if (!courseByRailsPlaylistId.has(playlistId)) courseByRailsPlaylistId.set(playlistId, row.id);
      // A course that already carries a Rails playlist id is never a slug
      // fallback, so another playlist cannot complete it by slug.
      continue;
    }

    const slug = normalizeSlug(row.slug);
    if (slug !== null && !courseBySlug.has(slug)) courseBySlug.set(slug, row.id);
  }

  return {
    lessonByRailsId,
    lessonBySlug,
    courseByRailsPlaylistId,
    courseBySlug,
    stats: {
      lessonRows: lessonRows.length,
      lessonRowsWithRailsId,
      duplicateLessonRowsForRailsId,
      courseRows: courseRows.length,
      courseRowsWithRailsPlaylistId,
    },
  };
}
