import type { JsonFields } from "./fields";

export type CourseAccess = "free" | "pro";

/**
 * Resolve the course access label across the Rails and CourseBuilder field
 * generations in the served database. Unknown courses stay pro by default so
 * a missing marker never promises free access.
 */
export function courseAccessFromFields(fields: JsonFields): CourseAccess {
  for (const value of [fields["accessState"], fields["access"]]) {
    if (typeof value !== "string") continue;

    const normalized = value.trim().toLowerCase();
    if (normalized === "free" || normalized === "public") return "free";
    if (normalized === "pro") return "pro";
  }

  if (fields["freeForever"] === true) return "free";
  if (fields["freeForever"] === false) return "pro";

  const visibility =
    typeof fields["visibility"] === "string" ? fields["visibility"].trim().toLowerCase() : null;

  return visibility === "public" ? "free" : "pro";
}
