import type { RowDataPacket } from "mysql2";

import { createLocalMysqlConnection } from "../db/local-docker";
import { repairDoubleEncodedUtf8 } from "./encoding";
import { publishedResourceSql } from "./publication";

type ContributorRow = RowDataPacket & {
  name: string;
  resourceCount: number;
  userId: string;
};

export type SearchInstructor = {
  name: string;
  resourceCount: number;
};

type ResolvedInstructor = SearchInstructor & { userIds: string[] };

// Letters whose base form is not an NFD decomposition (ł has no combining mark).
const FOLDED_LETTERS: Record<string, string> = {
  æ: "ae",
  đ: "d",
  ł: "l",
  ø: "o",
  œ: "oe",
  ß: "ss",
};

function comparableName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[æđłøœß]/g, (letter) => FOLDED_LETTERS[letter] ?? letter);
}

function matchKey(value: string) {
  const comparable = comparableName(value);
  // Names written entirely in non-Latin scripts strip to nothing — fall back
  // to the comparable form so they keep distinct keys instead of merging.
  return comparable.replace(/[^a-z0-9]/g, "") || comparable.trim();
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
    const name = repairDoubleEncodedUtf8(contributor.name);
    const key = matchKey(name);
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
  const key = matchKey(name);
  if (!key) return [];
  const instructors = await allInstructors();
  return instructors.find((instructor) => matchKey(instructor.name) === key)?.userIds ?? [];
}
