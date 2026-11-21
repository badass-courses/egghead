import type { JsonFields } from "./fields";

/**
 * Lesson-level free marking, resolved across the field generations that exist
 * in the served CourseBuilder database. Rails anonymous truth is runtime
 * `lessons.is_pro_content`: any viewable lesson with `is_pro_content=false`
 * is free, even when the older `free_forever` mirror is false.
 *
 * 1. `isProContent` / `is_pro_content` (boolean) — Rails runtime gate.
 * 2. `freeAccess` (boolean) — older import mirror, historically sourced from
 *    Rails `free_forever`.
 * 3. `free_forever` (boolean) — defensive snake_case Rails mirror.
 * 4. `access` ('free' | 'pro') — CourseBuilder-native post access field.
 * 5. `freeForever` (boolean) — rehearsal/manifest layer. Known to be inflated
 *    (true on ~1.9K Rails-pro lessons that also carry `freeAccess: false`),
 *    so it only counts when no stronger signal is present.
 *
 * Anything else (including rows with no gating fields at all) is NOT free:
 * course-linked lessons gate by default. Standalone lessons gate only with an
 * explicit pro signal; a resolved lesson-level free marking always wins.
 */
export function lessonFreeForeverFromFields(fields: JsonFields): boolean {
  const isProContent = booleanOrNull(fields["isProContent"]);
  if (isProContent !== null) return !isProContent;

  const railsIsProContent = booleanOrNull(fields["is_pro_content"]);
  if (railsIsProContent !== null) return !railsIsProContent;

  const freeAccess = booleanOrNull(fields["freeAccess"]);
  if (freeAccess !== null) return freeAccess;

  const railsFreeForever = booleanOrNull(fields["free_forever"]);
  if (railsFreeForever !== null) return railsFreeForever;

  const access = lowerTextOrNull(fields["access"]);
  if (access === "free") return true;
  if (access === "pro") return false;

  return fields["freeForever"] === true;
}

/** Explicit paid intent, including the older Rails freeAccess mirror. */
export function lessonExplicitlyProFromFields(fields: JsonFields): boolean {
  return (
    fields["isProContent"] === true ||
    fields["is_pro_content"] === true ||
    lowerTextOrNull(fields["access"]) === "pro" ||
    fields["freeAccess"] === false
  );
}

export function lessonHasRailsProContentSignal(fields: JsonFields): boolean {
  return (
    booleanOrNull(fields["isProContent"]) !== null ||
    booleanOrNull(fields["is_pro_content"]) !== null
  );
}

/**
 * SQL twin of `lessonFreeForeverFromFields` for queries that filter on the
 * free marking directly. Keep the two in lockstep.
 */
export function lessonFreeForeverSql(alias: string) {
  return `
    COALESCE(
      CASE
        WHEN JSON_TYPE(JSON_EXTRACT(${alias}.fields, '$.isProContent')) = 'BOOLEAN'
          THEN JSON_EXTRACT(${alias}.fields, '$.isProContent') = CAST('false' AS JSON)
        WHEN JSON_TYPE(JSON_EXTRACT(${alias}.fields, '$.is_pro_content')) = 'BOOLEAN'
          THEN JSON_EXTRACT(${alias}.fields, '$.is_pro_content') = CAST('false' AS JSON)
        WHEN JSON_TYPE(JSON_EXTRACT(${alias}.fields, '$.freeAccess')) = 'BOOLEAN'
          THEN JSON_EXTRACT(${alias}.fields, '$.freeAccess') = CAST('true' AS JSON)
        WHEN JSON_TYPE(JSON_EXTRACT(${alias}.fields, '$.free_forever')) = 'BOOLEAN'
          THEN JSON_EXTRACT(${alias}.fields, '$.free_forever') = CAST('true' AS JSON)
        WHEN LOWER(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${alias}.fields, '$.access')))) IN ('free', 'pro')
          THEN LOWER(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${alias}.fields, '$.access')))) = 'free'
        ELSE JSON_EXTRACT(${alias}.fields, '$.freeForever') = CAST('true' AS JSON)
      END,
      FALSE
    )
  `;
}

/** SQL twin of `lessonExplicitlyProFromFields`. */
export function lessonExplicitlyProSql(alias: string) {
  return `COALESCE((
    (JSON_TYPE(JSON_EXTRACT(${alias}.fields, '$.isProContent')) = 'BOOLEAN'
      AND JSON_EXTRACT(${alias}.fields, '$.isProContent') = CAST('true' AS JSON))
    OR (JSON_TYPE(JSON_EXTRACT(${alias}.fields, '$.is_pro_content')) = 'BOOLEAN'
      AND JSON_EXTRACT(${alias}.fields, '$.is_pro_content') = CAST('true' AS JSON))
    OR LOWER(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${alias}.fields, '$.access')))) = 'pro'
    OR (JSON_TYPE(JSON_EXTRACT(${alias}.fields, '$.freeAccess')) = 'BOOLEAN'
      AND JSON_EXTRACT(${alias}.fields, '$.freeAccess') = CAST('false' AS JSON))
  ), FALSE)`;
}

/**
 * Access law: courses, course-linked lessons and explicitly pro standalone
 * lessons gate. A resolved lesson-level free marking always wins.
 */
export function lessonRequiresAccess(input: {
  courseLinked: boolean;
  freeForever: boolean;
  isProContent: boolean;
}) {
  return (input.courseLinked || input.isProContent) && !input.freeForever;
}

/** SQL twin of `lessonRequiresAccess`; courseLinkedSql is the caller's link predicate. */
export function lessonRequiresAccessSql(alias: string, courseLinkedSql: string) {
  return `((${courseLinkedSql} OR ${lessonExplicitlyProSql(alias)})
    AND NOT ${lessonFreeForeverSql(alias)})`;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function lowerTextOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed : null;
}
