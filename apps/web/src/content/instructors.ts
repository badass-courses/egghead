import type { RowDataPacket } from "mysql2";

import { createLocalMysqlConnection } from "../db/local-docker";
import {
  comparableInstructorName,
  instructorMatchKey,
  normalizeInstructorDisplayName,
} from "./encoding";
import { publishedResourceSql } from "./publication";

type ContributorRow = RowDataPacket & {
  name: string;
  resourceCount: number;
  userId: string;
};

type ContentContributorRow = RowDataPacket & {
  contentId: string;
  name: string;
};

export type SearchInstructor = {
  name: string;
  resourceCount: number;
};

type ResolvedInstructor = SearchInstructor & { userIds: string[] };

function comparableName(value: string) {
  return comparableInstructorName(value);
}

async function contributorRows(): Promise<ContributorRow[]> {
  const connection = await createLocalMysqlConnection();

  try {
    const [rows] = await connection.execute<ContributorRow[]>(
      `
        SELECT user.id AS userId,
               user.name AS name,
               COUNT(DISTINCT resource.id) AS resourceCount
        FROM egghead_ContentContribution contribution
        JOIN egghead_User user ON user.id = contribution.userId
        JOIN egghead_ContentResource resource ON resource.id = contribution.contentId
        WHERE resource.deletedAt IS NULL
          ${publishedResourceSql("resource")}
          AND user.name IS NOT NULL
          AND user.name != ''
        GROUP BY user.id, user.name
        ORDER BY resourceCount DESC, user.name ASC
      `,
    );

    return rows;
  } finally {
    await connection.end();
  }
}

// Stored names can be double-encoded and accented, so matching happens in JS
// over the repaired names instead of SQL LIKE. The instructor list is small
// and the query is a cheap local aggregate, so it runs uncached.
async function allInstructors(): Promise<ResolvedInstructor[]> {
  const contributors = await contributorRows();

  const byKey = new Map<string, ResolvedInstructor>();
  for (const contributor of contributors) {
    const name = normalizeInstructorDisplayName(contributor.name);
    const key = instructorMatchKey(name);
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      existing.resourceCount += contributor.resourceCount;
      existing.userIds.push(contributor.userId);
    } else {
      byKey.set(key, {
        name,
        resourceCount: contributor.resourceCount,
        userIds: [contributor.userId],
      });
    }
  }

  return [...byKey.values()].toSorted(
    (a, b) => b.resourceCount - a.resourceCount || a.name.localeCompare(b.name),
  );
}

function withoutUserIds({ name, resourceCount }: ResolvedInstructor): SearchInstructor {
  return { name, resourceCount };
}

export async function topSearchInstructors(limit = 6): Promise<SearchInstructor[]> {
  const instructors = await allInstructors();
  return instructors.slice(0, limit).map(withoutUserIds);
}

export async function searchInstructorsByName(
  term: string,
  limit = 8,
): Promise<SearchInstructor[]> {
  const normalized = comparableName(term.trim());
  if (!normalized) return topSearchInstructors(limit);

  const instructors = await allInstructors();
  return instructors
    .filter((instructor) => comparableName(instructor.name).includes(normalized))
    .slice(0, limit)
    .map(withoutUserIds);
}

export async function instructorUserIdsForName(name: string): Promise<string[]> {
  const key = instructorMatchKey(name);
  if (!key) return [];
  const instructors = await allInstructors();
  return (
    instructors.find((instructor) => instructorMatchKey(instructor.name) === key)?.userIds ?? []
  );
}

export async function instructorNamesByContentId(contentIds: readonly string[]) {
  const uniqueContentIds = [...new Set(contentIds)];
  const namesByContentId = new Map<string, string[]>();
  if (uniqueContentIds.length === 0) return namesByContentId;

  const connection = await createLocalMysqlConnection();
  try {
    const contentIdBatches = Array.from(
      { length: Math.ceil(uniqueContentIds.length / 1_000) },
      (_, batchIndex) => uniqueContentIds.slice(batchIndex * 1_000, (batchIndex + 1) * 1_000),
    );
    const rowBatches = await Promise.all(
      contentIdBatches.map(async (contentIdBatch) => {
        const [rows] = await connection.execute<ContentContributorRow[]>(
          `
            SELECT DISTINCT contribution.contentId, user.name
            FROM egghead_ContentContribution contribution
            JOIN egghead_User user ON user.id = contribution.userId
            WHERE contribution.contentId IN (${contentIdBatch.map(() => "?").join(", ")})
              AND user.name IS NOT NULL
              AND user.name != ''
            ORDER BY contribution.contentId, user.name
          `,
          contentIdBatch,
        );
        return rows;
      }),
    );

    const keysByContentId = new Map<string, Set<string>>();
    for (const rows of rowBatches) {
      for (const row of rows) {
        const name = normalizeInstructorDisplayName(row.name);
        const key = instructorMatchKey(name);
        if (!key) continue;

        const keys = keysByContentId.get(row.contentId) ?? new Set<string>();
        if (keys.has(key)) continue;
        keys.add(key);
        keysByContentId.set(row.contentId, keys);

        const names = namesByContentId.get(row.contentId) ?? [];
        names.push(name);
        namesByContentId.set(row.contentId, names);
      }
    }

    return namesByContentId;
  } finally {
    await connection.end();
  }
}
