import { publishedResourceSql } from "./publication";

function jsonString(alias: string, key: string) {
  return `JSON_UNQUOTE(JSON_EXTRACT(${alias}.fields, '$.${key}'))`;
}

function courseResourceCondition(alias: string) {
  return `
    (
      ${alias}.type = 'course'
      OR (
        ${alias}.type = 'post'
        AND ${jsonString(alias, "postType")} = 'course'
      )
    )
  `;
}

/**
 * SQL twin of the Routing V2 canonical lesson row preference in
 * `tools/me.ts` (`compareContentRoutingV2CanonicalRows`). Keep this narrow:
 * app lesson reads already filter to lesson-family rows, so cross-family
 * Routing V2 rules like talk shadows and dual-surface slugs do not belong here.
 */
export function canonicalLessonOrderSql(alias: string) {
  return `
    (
      SELECT COUNT(*)
      FROM egghead_ContentResourceResource canonicalLink
      JOIN egghead_ContentResource canonicalParent
        ON canonicalParent.id = canonicalLink.resourceOfId
       AND canonicalParent.deletedAt IS NULL
       ${publishedResourceSql("canonicalParent")}
      WHERE canonicalLink.resourceId = ${alias}.id
        AND ${courseResourceCondition("canonicalParent")}
    ) DESC,
    CASE WHEN JSON_EXTRACT(${alias}.fields, '$.betaBodyFallbackBackfill') IS NULL THEN 0 ELSE 1 END ASC,
    CHAR_LENGTH(
      COALESCE(
        ${jsonString(alias, "body")},
        ${jsonString(alias, "markdown")},
        ''
      )
    ) DESC,
    CASE LOWER(COALESCE(${jsonString(alias, "state")}, 'published'))
      WHEN 'published' THEN 0
      WHEN 'retired' THEN 1
      ELSE 2
    END ASC,
    ${alias}.updatedAt DESC,
    ${alias}.createdAt DESC,
    ${alias}.id ASC
  `;
}
