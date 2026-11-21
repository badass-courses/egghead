import { and, eq, isNull, sql } from "drizzle-orm";
import type { contentResource } from "@/db/schema";
import type { ContentAudit } from "@egghead/core/content";
import type { StoredPost } from "./store";

/** Shared SQL for PlanetScale and the isolated MySQL contract harness. */
export function draftWrite(
  table: typeof contentResource,
  current: StoredPost,
  changes: Record<string, unknown>,
  audit: ContentAudit & { at: string },
) {
  return {
    values: {
      fields: sql`JSON_SET(JSON_MERGE_PATCH(${table.fields}, CAST(${JSON.stringify(changes)} AS JSON)), '$.contentMcpAudit', JSON_ARRAY_APPEND(COALESCE(JSON_EXTRACT(${table.fields}, '$.contentMcpAudit'), JSON_ARRAY()), '$', CAST(${JSON.stringify(audit)} AS JSON)))`,
      updatedAt: new Date(),
    },
    where: and(
      eq(table.id, current.id),
      eq(table.type, "post"),
      eq(table.createdById, current.createdById),
      isNull(table.deletedAt),
      sql`JSON_UNQUOTE(JSON_EXTRACT(${table.fields}, '$.state')) = 'draft'`,
      sql`${table.fields} = CAST(${JSON.stringify(current.fields)} AS JSON)`,
    ),
  };
}
