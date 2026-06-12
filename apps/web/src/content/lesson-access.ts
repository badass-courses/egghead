import type { JsonFields } from "./fields";

/**
 * Lesson-level free marking, resolved across the field generations that exist
 * in the served CourseBuilder database. Rails truth (`lessons.free_forever`)
 * arrived through several importers that wrote different field names:
 *
 * 1. `freeAccess` (boolean) — written by `migration/scripts/migrate-lessons.ts`
 *    directly from Rails `free_forever`. Strongest signal; wins when present.
 * 2. `free_forever` (boolean) — defensive snake_case Rails mirror.
 * 3. `access` ('free' | 'pro') — CourseBuilder-native post access field.
 * 4. `freeForever` (boolean) — rehearsal/manifest layer. Known to be inflated
 *    (true on ~1.9K Rails-pro lessons that also carry `freeAccess: false`),
 *    so it only counts when no stronger signal is present.
 *
 * Anything else (including rows with no gating fields at all) is NOT free:
 * course-linked lessons gate by default.
 */
export function lessonFreeForeverFromFields(fields: JsonFields): boolean {
  const freeAccess = booleanOrNull(fields["freeAccess"]);
  if (freeAccess !== null) return freeAccess;

  const railsFreeForever = booleanOrNull(fields["free_forever"]);
  if (railsFreeForever !== null) return railsFreeForever;

  const access = lowerTextOrNull(fields["access"]);
  if (access === "free") return true;
  if (access === "pro") return false;

  return fields["freeForever"] === true;
}

/**
 * SQL twin of `lessonFreeForeverFromFields` for queries that filter on the
 * free marking directly. Keep the two in lockstep.
 */
export function lessonFreeForeverSql(alias: string) {
  return `
    COALESCE(
      CASE
        WHEN JSON_TYPE(JSON_EXTRACT(${alias}.fields, '$.freeAccess')) = 'BOOLEAN'
          THEN JSON_EXTRACT(${alias}.fields, '$.freeAccess') = CAST('true' AS JSON)
        WHEN JSON_TYPE(JSON_EXTRACT(${alias}.fields, '$.free_forever')) = 'BOOLEAN'
          THEN JSON_EXTRACT(${alias}.fields, '$.free_forever') = CAST('true' AS JSON)
        WHEN LOWER(JSON_UNQUOTE(JSON_EXTRACT(${alias}.fields, '$.access'))) IN ('free', 'pro')
          THEN LOWER(JSON_UNQUOTE(JSON_EXTRACT(${alias}.fields, '$.access'))) = 'free'
        ELSE JSON_EXTRACT(${alias}.fields, '$.freeForever') = CAST('true' AS JSON)
      END,
      FALSE
    )
  `;
}

/**
 * Access law: only course-linked lessons may gate, and a lesson-level free
 * marking always wins over course-level gating (Rails `free_forever` truth).
 */
export function lessonRequiresAccess(input: { courseLinked: boolean; freeForever: boolean }) {
  return input.courseLinked && !input.freeForever;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function lowerTextOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed : null;
}
