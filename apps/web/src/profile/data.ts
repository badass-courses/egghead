import type { ResultSetHeader, RowDataPacket } from "mysql2";

import {
  entitlementGrantsAccess,
  evaluateAccessEntitlementRows,
  readAccessEntitlementsForUser,
  type AccessEntitlementRow,
} from "../access/evaluate";
import { fieldsFromJson, stringField } from "../content/fields";
import { publishedResourceSql } from "../content/publication";
import {
  collectionPath,
  legacyLessonPath,
  legacyPublicContentPath,
  STANDALONE_PUBLIC_CONTENT_FAMILIES,
  type PublicContentFamily,
} from "../content/routes";
import { createLocalMysqlConnection } from "../db/local-docker";
import {
  ownerScopedNameUpdate,
  parsePublicProfileId,
  projectPublicLearnerProfile,
  requireProfileOwner,
  type ProfileCompletion,
  type PublicLearnerProfile,
} from "./contracts";
import { summarizeGithubConnection, type GithubConnectionState } from "./github-disconnect";

type PrivateUserRow = RowDataPacket & {
  id: string;
  name: string | null;
  email: string;
  createdAt: Date | null;
};

type PublicUserRow = RowDataPacket & {
  id: string;
  name: string | null;
  image: string | null;
  createdAt: Date | null;
};

type AccountRow = RowDataPacket & {
  provider: string;
};

type CompletionRow = RowDataPacket & {
  resourceId: string;
  completedAt: Date;
  type: string;
  fields: unknown;
};

type CompletionStatsRow = RowDataPacket & {
  completedCount: number | string;
  activeMonthCount: number | string;
};

type CourseAccessRow = RowDataPacket & {
  id: string;
  fields: unknown;
};

export type PrivateAccessibleCourse = {
  id: string;
  title: string;
  href: string;
};

export type PrivateAccountProfile = {
  id: string;
  name: string | null;
  email: string;
  memberSince: Date | null;
  publicProfilePath: string;
  githubConnection: GithubConnectionState;
  learningAccess: {
    libraryWide: boolean;
    courseSpecific: PrivateAccessibleCourse[];
    legacyProQuarantined: boolean;
  };
  learning: {
    completedCount: number;
    recentlyCompleted: ProfileCompletion[];
  };
};

export const PRIVATE_PROFILE_USER_SQL = `
  SELECT user.id, user.name, user.email, user.createdAt
  FROM egghead_User user
  WHERE user.id = ?
  LIMIT 1
`;

export const PUBLIC_PROFILE_USER_SQL = `
  SELECT user.id, user.name, user.image, user.createdAt
  FROM egghead_User user
  WHERE user.id = ?
  LIMIT 1
`;

export const OWNER_SCOPED_NAME_UPDATE_SQL = `
  UPDATE egghead_User
  SET name = ?
  WHERE id = ?
  LIMIT 1
`;

export const PRIVATE_PROFILE_ACCOUNTS_SQL = `
  SELECT account.provider
  FROM egghead_Account account
  WHERE account.userId = ?
  ORDER BY account.provider ASC
`;

const PROFILE_COMPLETION_FAMILIES = [
  "course",
  "lesson",
  ...STANDALONE_PUBLIC_CONTENT_FAMILIES,
] as const;
const PROFILE_COMPLETION_FAMILY_SQL = PROFILE_COMPLETION_FAMILIES.map(
  (family) => `'${family}'`,
).join(", ");

export const ROUTABLE_PROFILE_COMPLETION_SQL = `
  AND JSON_TYPE(JSON_EXTRACT(resource.fields, '$.slug')) = 'STRING'
  AND LOWER(TRIM(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.slug')))) NOT IN ('', 'null')
  AND CAST(
    CASE
      WHEN JSON_TYPE(JSON_EXTRACT(resource.fields, '$.postType')) = 'STRING'
        AND LOWER(TRIM(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')))) NOT IN ('', 'null')
      THEN TRIM(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')))
      ELSE resource.type
    END AS BINARY
  ) IN (${PROFILE_COMPLETION_FAMILY_SQL})
`;

function isPublicContentFamily(value: string): value is PublicContentFamily {
  return STANDALONE_PUBLIC_CONTENT_FAMILIES.some((family) => family === value);
}

function completionHref(type: string, fields: Record<string, unknown>, slug: string) {
  const family = stringField(fields, "postType") ?? type;

  if (family === "course") return collectionPath(slug);
  if (family === "lesson") return legacyLessonPath(slug);
  if (isPublicContentFamily(family)) return legacyPublicContentPath(family, slug);

  return null;
}

function completionFromRow(row: CompletionRow): ProfileCompletion | null {
  const fields = fieldsFromJson(row.fields);
  const slug = stringField(fields, "slug");
  if (!slug) return null;

  const href = completionHref(row.type, fields, slug);
  if (!href) return null;

  return {
    resourceId: row.resourceId,
    title: stringField(fields, "title") ?? "Untitled resource",
    href,
    completedAt: row.completedAt,
  };
}

async function readIdentityWithAccounts(userId: string) {
  const connection = await createLocalMysqlConnection();

  try {
    const [userRows] = await connection.execute<PrivateUserRow[]>(PRIVATE_PROFILE_USER_SQL, [
      userId,
    ]);
    const [accountRows] = await connection.execute<AccountRow[]>(PRIVATE_PROFILE_ACCOUNTS_SQL, [
      userId,
    ]);

    return {
      user: userRows[0] ?? null,
      accounts: accountRows,
    };
  } finally {
    await connection.end();
  }
}

async function readPublishedCompletions(userId: string, limit: number) {
  const connection = await createLocalMysqlConnection();
  const safeLimit = Math.max(1, Math.min(250, Math.floor(limit)));

  try {
    const [rows] = await connection.execute<CompletionRow[]>(
      `
        SELECT
          progress.resourceId,
          progress.completedAt,
          resource.type,
          resource.fields
        FROM egghead_ResourceProgress progress
        JOIN egghead_ContentResource resource
          ON resource.id = progress.resourceId
         AND resource.deletedAt IS NULL
        WHERE progress.userId = ?
          AND progress.completedAt IS NOT NULL
          ${publishedResourceSql("resource")}
          ${ROUTABLE_PROFILE_COMPLETION_SQL}
        ORDER BY progress.completedAt DESC, progress.resourceId ASC
        LIMIT ${safeLimit}
      `,
      [userId],
    );

    return rows
      .map(completionFromRow)
      .filter((completion): completion is ProfileCompletion => completion !== null);
  } finally {
    await connection.end();
  }
}

async function readPublishedCompletionStats(userId: string) {
  const connection = await createLocalMysqlConnection();

  try {
    const [rows] = await connection.execute<CompletionStatsRow[]>(
      `
        SELECT
          COUNT(*) AS completedCount,
          COUNT(DISTINCT DATE_FORMAT(progress.completedAt, '%Y-%m')) AS activeMonthCount
        FROM egghead_ResourceProgress progress
        JOIN egghead_ContentResource resource
          ON resource.id = progress.resourceId
         AND resource.deletedAt IS NULL
        WHERE progress.userId = ?
          AND progress.completedAt IS NOT NULL
          ${publishedResourceSql("resource")}
      `,
      [userId],
    );

    return {
      completedCount: Number(rows[0]?.completedCount ?? 0),
      activeMonthCount: Number(rows[0]?.activeMonthCount ?? 0),
    };
  } finally {
    await connection.end();
  }
}

function accessiblePlaylistIds(
  rows: readonly AccessEntitlementRow[],
  requestCountry: string | null,
) {
  const ids = new Set<string>();

  for (const row of rows) {
    if (!row.sellableId || row.sellableType !== "Playlist") continue;
    if (
      entitlementGrantsAccess(row, {
        legacyRailsPlaylistId: row.sellableId,
        requestCountry,
      })
    ) {
      ids.add(row.sellableId);
    }
  }

  return [...ids];
}

async function readAccessibleCourses(playlistIds: readonly string[]) {
  if (playlistIds.length === 0) return [];

  const connection = await createLocalMysqlConnection();
  const placeholders = playlistIds.map(() => "?").join(", ");

  try {
    const [rows] = await connection.execute<CourseAccessRow[]>(
      `
        SELECT course.id, course.fields
        FROM egghead_ContentResource course
        WHERE course.deletedAt IS NULL
          ${publishedResourceSql("course")}
          AND (
            course.type = 'course'
            OR (
              course.type = 'post'
              AND JSON_UNQUOTE(JSON_EXTRACT(course.fields, '$.postType')) = 'course'
            )
          )
          AND JSON_UNQUOTE(JSON_EXTRACT(course.fields, '$.legacyRailsPlaylistId')) IN (${placeholders})
        ORDER BY course.createdAt DESC, course.id ASC
        LIMIT 24
      `,
      [...playlistIds],
    );

    return rows
      .map((row): PrivateAccessibleCourse | null => {
        const fields = fieldsFromJson(row.fields);
        const slug = stringField(fields, "slug");
        if (!slug) return null;

        return {
          id: row.id,
          title: stringField(fields, "title") ?? "Untitled course",
          href: collectionPath(slug),
        };
      })
      .filter((course): course is PrivateAccessibleCourse => course !== null);
  } finally {
    await connection.end();
  }
}

export async function getPrivateAccountProfile(input: {
  actorUserId: string | null;
  profileUserId: string;
  requestCountry: string | null;
  emailAuthConfigured: boolean;
}): Promise<PrivateAccountProfile | null> {
  const userId = requireProfileOwner(input.actorUserId, input.profileUserId);
  const [identity, entitlementRows, recentlyCompleted, completionStats] = await Promise.all([
    readIdentityWithAccounts(userId),
    readAccessEntitlementsForUser(userId),
    readPublishedCompletions(userId, 6),
    readPublishedCompletionStats(userId),
  ]);

  if (!identity.user) return null;

  const access = evaluateAccessEntitlementRows(entitlementRows, {
    requestCountry: input.requestCountry,
  });
  const courseSpecific = await readAccessibleCourses(
    accessiblePlaylistIds(entitlementRows, input.requestCountry),
  );

  return {
    id: identity.user.id,
    name: identity.user.name,
    email: identity.user.email,
    memberSince: identity.user.createdAt,
    publicProfilePath: `/profile/${encodeURIComponent(identity.user.id)}`,
    githubConnection: summarizeGithubConnection(
      identity.accounts,
      input.emailAuthConfigured && Boolean(identity.user.email.trim()),
    ),
    learningAccess: {
      libraryWide: access.granted,
      courseSpecific,
      legacyProQuarantined: access.ignored.quarantineEntitlements > 0,
    },
    learning: {
      completedCount: completionStats.completedCount,
      recentlyCompleted,
    },
  };
}

export async function getPublicLearnerProfile(
  candidatePublicId: string,
): Promise<PublicLearnerProfile | null> {
  const publicId = parsePublicProfileId(candidatePublicId);
  if (!publicId) return null;

  const connection = await createLocalMysqlConnection();

  try {
    const [userRows] = await connection.execute<PublicUserRow[]>(PUBLIC_PROFILE_USER_SQL, [
      publicId,
    ]);
    const user = userRows[0];
    if (!user) return null;

    const [completions, completionStats] = await Promise.all([
      readPublishedCompletions(publicId, 100),
      readPublishedCompletionStats(publicId),
    ]);

    return projectPublicLearnerProfile(user, completions, completionStats);
  } finally {
    await connection.end();
  }
}

export async function updatePrivateProfileName(input: {
  actorUserId: string | null;
  profileUserId: string;
  name: unknown;
}) {
  const update = ownerScopedNameUpdate(input);
  const connection = await createLocalMysqlConnection();

  try {
    const [result] = await connection.execute<ResultSetHeader>(OWNER_SCOPED_NAME_UPDATE_SQL, [
      update.name,
      update.userId,
    ]);

    return {
      updated: result.affectedRows === 1,
      userId: update.userId,
      name: update.name,
    };
  } finally {
    await connection.end();
  }
}
