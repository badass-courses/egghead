export const LESSON_STATIC_PARAM_LIMIT = 500;

const BLOCKED_VISIBILITY_VALUES = [
  "archived",
  "deleted",
  "draft",
  "private",
  "trash",
  "trashed",
  "unpublished",
] as const;

function jsonString(alias: string, key: string) {
  return `JSON_UNQUOTE(JSON_EXTRACT(${alias}.fields, '$.${key}'))`;
}

function blockedVisibilityList() {
  return BLOCKED_VISIBILITY_VALUES.map((value) => `'${value}'`).join(", ");
}

export function publicVisibilitySql(alias: string) {
  return `
    AND LOWER(COALESCE(${jsonString(alias, "visibility")}, 'public')) NOT IN (${blockedVisibilityList()})
    AND LOWER(COALESCE(${jsonString(alias, "visibilityState")}, 'public')) NOT IN (${blockedVisibilityList()})
  `;
}

export function publishedResourceSql(alias: string) {
  return `
    AND LOWER(COALESCE(${jsonString(alias, "state")}, 'published')) = 'published'
    ${publicVisibilitySql(alias)}
  `;
}

export function routeableLessonResourceSql(alias: string) {
  return `
    AND LOWER(COALESCE(${jsonString(alias, "state")}, 'published')) IN ('published', 'retired')
    ${publicVisibilitySql(alias)}
  `;
}
