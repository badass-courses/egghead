import type { ResultSetHeader, RowDataPacket } from "mysql2";

import {
  entitlementGrantsAccess,
  evaluateAccessEntitlementRows,
  readAccessEntitlementsForUser,
  type AccessEntitlementRow,
} from "../access/evaluate";
import { fieldsFromJson, stringField } from "../content/fields";
import {
  lessonCanonicalPathForRouteContext,
  parentCourseRouteContextsForLessonIds,
  type ParentCourseRouteContext,
} from "../content/lesson-route-context";
import { publishedResourceSql } from "../content/publication";
import {
  collectionPath,
  legacyPublicContentPath,
  STANDALONE_PUBLIC_CONTENT_FAMILIES,
  type PublicContentFamily,
} from "../content/routes";
import { createLocalMysqlConnection } from "../db/local-docker";
import { gravatarUrlForEmail } from "./gravatar";
import {
  ownerScopedNameUpdate,
  parsePublicProfileId,
  projectPublicLearnerProfile,
  requireProfileOwner,
  type ProfileCompletion,
  type ProfileCompletionFamily,
  type ProfileCompletionFilter,
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

type PublicProfileGravatarRow = RowDataPacket & {
  email: string;
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
  lessonCount: number | string;
  courseCount: number | string;
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
    lessonCount: number;
    courseCount: number;
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

export const PUBLIC_PROFILE_GRAVATAR_SQL = `
  SELECT user.email
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
const PROFILE_RESOURCE_FAMILY_SQL = `
  CAST(
    CASE
      WHEN JSON_TYPE(JSON_EXTRACT(resource.fields, '$.postType')) = 'STRING'
        AND LOWER(TRIM(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')))) NOT IN ('', 'null')
      THEN TRIM(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.postType')))
      ELSE resource.type
    END AS BINARY
  )
`;

export const ROUTABLE_PROFILE_COMPLETION_SQL = `
  AND JSON_TYPE(JSON_EXTRACT(resource.fields, '$.slug')) = 'STRING'
  AND LOWER(TRIM(JSON_UNQUOTE(JSON_EXTRACT(resource.fields, '$.slug')))) NOT IN ('', 'null')
  AND ${PROFILE_RESOURCE_FAMILY_SQL} IN (${PROFILE_COMPLETION_FAMILY_SQL})
`;

export const PUBLISHED_COMPLETION_STATS_SQL = `
  SELECT
    SUM(
      CASE WHEN ${PROFILE_RESOURCE_FAMILY_SQL} = CAST('lesson' AS BINARY) THEN 1 ELSE 0 END
    ) AS lessonCount,
    SUM(
      CASE WHEN ${PROFILE_RESOURCE_FAMILY_SQL} = CAST('course' AS BINARY) THEN 1 ELSE 0 END
    ) AS courseCount,
    COUNT(DISTINCT DATE_FORMAT(progress.completedAt, '%Y-%m')) AS activeMonthCount
  FROM egghead_ResourceProgress progress
  JOIN egghead_ContentResource resource
    ON resource.id = progress.resourceId
   AND resource.deletedAt IS NULL
  WHERE progress.userId = ?
    AND progress.completedAt IS NOT NULL
    ${publishedResourceSql("resource")}
`;

function isPublicContentFamily(value: string): value is PublicContentFamily {
  return STANDALONE_PUBLIC_CONTENT_FAMILIES.some((family) => family === value);
}

function completionFamily(
  type: string,
  fields: Record<string, unknown>,
): ProfileCompletionFamily | null {
  const family = stringField(fields, "postType") ?? type;

  if (family === "course" || family === "lesson" || isPublicContentFamily(family)) return family;

  return null;
}

function completionHref(
  family: ProfileCompletionFamily,
  slug: string,
  parentCourse: ParentCourseRouteContext | null,
) {
  if (family === "course") return collectionPath(slug);
  if (family === "lesson") {
    return lessonCanonicalPathForRouteContext(slug, parentCourse?.slug);
  }

  return legacyPublicContentPath(family, slug);
}

function completionFromRow(
  row: CompletionRow,
  parentCourse: ParentCourseRouteContext | null,
): ProfileCompletion | null {
  const fields = fieldsFromJson(row.fields);
  const slug = stringField(fields, "slug");
  const family = completionFamily(row.type, fields);
  if (!slug || !family) return null;

  return {
    resourceId: row.resourceId,
    family,
    title: stringField(fields, "title") ?? "Untitled resource",
    href: completionHref(family, slug, parentCourse),
    course:
      family === "lesson" && parentCourse
        ? {
            title: parentCourse.title,
            href: parentCourse.href,
          }
        : null,
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

async function readPublishedCompletions(
  userId: string,
  limit: number,
  family?: ProfileCompletionFilter,
) {
  const connection = await createLocalMysqlConnection();
  const safeLimit = Math.max(1, Math.min(250, Math.floor(limit)));
  const familyFilterSql = family ? `AND ${PROFILE_RESOURCE_FAMILY_SQL} = CAST(? AS BINARY)` : "";

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
          ${familyFilterSql}
        ORDER BY progress.completedAt DESC, progress.resourceId ASC
        LIMIT ${safeLimit}
      `,
      family ? [userId, family] : [userId],
    );

    const parentCourses = await parentCourseRouteContextsForLessonIds(
      connection,
      rows.map((row) => row.resourceId),
    );

    return rows
      .map((row) => completionFromRow(row, parentCourses.get(row.resourceId) ?? null))
      .filter((completion): completion is ProfileCompletion => completion !== null);
  } finally {
    await connection.end();
  }
}

async function readPublishedCompletionStats(userId: string) {
  const connection = await createLocalMysqlConnection();

  try {
    const [rows] = await connection.execute<CompletionStatsRow[]>(PUBLISHED_COMPLETION_STATS_SQL, [
      userId,
    ]);

    return {
      lessonCount: Number(rows[0]?.lessonCount ?? 0),
      courseCount: Number(rows[0]?.courseCount ?? 0),
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
  recentCompletionFamily?: ProfileCompletionFilter;
}): Promise<PrivateAccountProfile | null> {
  const userId = requireProfileOwner(input.actorUserId, input.profileUserId);
  const [identity, entitlementRows, recentlyCompleted, completionStats] = await Promise.all([
    readIdentityWithAccounts(userId),
    readAccessEntitlementsForUser(userId),
    readPublishedCompletions(userId, 6, input.recentCompletionFamily),
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
      lessonCount: completionStats.lessonCount,
      courseCount: completionStats.courseCount,
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

export async function getPublicProfileGravatarUrl(
  candidatePublicId: string,
): Promise<string | null> {
  const publicId = parsePublicProfileId(candidatePublicId);
  if (!publicId) return null;

  const connection = await createLocalMysqlConnection();

  try {
    const [rows] = await connection.execute<PublicProfileGravatarRow[]>(
      PUBLIC_PROFILE_GRAVATAR_SQL,
      [publicId],
    );
    const email = rows[0]?.email.trim();
    if (!email) return null;

    const url = gravatarUrlForEmail(email, 176);
    const response = await fetch(url, { cache: "force-cache", method: "HEAD" });

    return response.ok ? url : null;
  } catch {
    return null;
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
