import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { draftWrite } from "./draft-write";
import { courseBuilderAdapter, db } from "@/db";
import { contentResource } from "@/db/schema";
import { contentStoreLayer, type ContentPersistence, type StoredPost } from "./store";

function stored(row: typeof contentResource.$inferSelect): StoredPost {
  // The published adapter's JSON column is loose; narrow it at this boundary.
  const fields: Record<string, unknown> = row.fields ?? {};
  return {
    id: row.id,
    type: row.type,
    createdById: row.createdById,
    deletedAt: row.deletedAt,
    fields,
  };
}

const persistence: ContentPersistence = {
  read: async (id) => {
    const row = await db.query.contentResource.findFirst({ where: eq(contentResource.id, id) });
    return row ? stored(row) : null;
  },
  list: async ({ limit, cursor, ownerId }) => {
    const rows = await db
      .select()
      .from(contentResource)
      .where(
        and(
          eq(contentResource.type, "post"),
          isNull(contentResource.deletedAt),
          cursor ? gt(contentResource.id, cursor) : undefined,
          ownerId ? eq(contentResource.createdById, ownerId) : undefined,
        ),
      )
      .orderBy(asc(contentResource.id))
      .limit(limit + 1);
    return rows.map(stored);
  },
  create: async (post) => courseBuilderAdapter.createContentResource(post),
  compareAndSwap: async (current, changes, audit) => {
    // updateContentResourceFields performs an unguarded read/merge/write. Use the same
    // table with a CAS predicate so a concurrent publish or ownership change cannot
    // turn this draft-only operation into a published-content edit. Audit is atomic.
    const write = draftWrite(contentResource, current, changes, audit);
    const result = await db.update(contentResource).set(write.values).where(write.where);
    return result.rowsAffected === 1;
  },
};

/** Native CourseBuilder rows only. No Rails, search-index, publish or commerce side effects. */
export const courseBuilderContentStore = () => contentStoreLayer(persistence);
