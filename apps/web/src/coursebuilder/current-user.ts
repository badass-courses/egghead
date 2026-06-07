import { createHash } from "node:crypto";
import type { RowDataPacket } from "mysql2";

import { evaluateContentAccessForUser } from "../access/evaluate";
import { createLocalMysqlConnection } from "../db/local-docker";

type FixtureUserRow = RowDataPacket & {
  userId: string;
};

type RehearsalCohort =
  | "active_individual_subscriber"
  | "active_team_seat_learner"
  | "anonymous"
  | "bare_legacy_pro_quarantined"
  | "expired_canceled_subscriber"
  | "free_signed_in"
  | "instructor_admin_support"
  | "paid_course_purchaser"
  | "team_owner_admin";

type CurrentUserContext = {
  legacyRailsPlaylistId?: number | null;
};

type CurrentUserPayload = {
  id: string;
  role: "user";
  identitySource: "coursebuilder-local-docker-fixture";
  cohort: RehearsalCohort;
  access: Awaited<ReturnType<typeof evaluateContentAccessForUser>>;
  support: {
    accessSummary: string;
  };
};

export type CurrentUserReadModel = {
  localUserId: string | null;
  contentAccess: Awaited<ReturnType<typeof evaluateContentAccessForUser>> | null;
  user: CurrentUserPayload | null;
  compatibility: {
    anonymousReturnsNullUser: true;
    invalidCredentialRejected?: true;
    fixtureSignedInUser?: true;
    rehearsalCohort?: RehearsalCohort;
    rehearsalCohortUnavailable?: true;
  };
};

function hashUserId(userId: string) {
  return createHash("sha1").update(`coursebuilder-user:${userId}`).digest("hex").slice(0, 16);
}

async function findActiveAllAccessFixtureUserId() {
  return findRehearsalCohortUserId("active_individual_subscriber", {});
}

function normalizeRehearsalCohort(value: string | null): RehearsalCohort | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "active_all_access_user") return "active_individual_subscriber";
  if (normalized === "team_owner") return "team_owner_admin";
  if (normalized === "legacy_pro") return "bare_legacy_pro_quarantined";
  if (normalized === "staff") return "instructor_admin_support";

  const cohorts: RehearsalCohort[] = [
    "active_individual_subscriber",
    "active_team_seat_learner",
    "anonymous",
    "bare_legacy_pro_quarantined",
    "expired_canceled_subscriber",
    "free_signed_in",
    "instructor_admin_support",
    "paid_course_purchaser",
    "team_owner_admin",
  ];

  return cohorts.find((cohort) => cohort === normalized) ?? null;
}

async function findRehearsalCohortUserId(cohort: RehearsalCohort, context: CurrentUserContext) {
  if (cohort === "anonymous") return null;

  const connection = await createLocalMysqlConnection();

  try {
    if (cohort === "active_individual_subscriber") {
      const [rows] = await connection.execute<FixtureUserRow[]>(
        `
        SELECT userId
        FROM egghead_Entitlement
        WHERE deletedAt IS NULL
          AND entitlementType = 'egghead_all_access_subscription'
          AND sourceType = 'rails_account_subscription'
          AND userId IS NOT NULL
          AND (expiresAt IS NULL OR expiresAt > CURRENT_TIMESTAMP(3))
          AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.status')) = 'active'
        ORDER BY id ASC
        LIMIT 1
      `,
      );

      return rows[0]?.userId ?? null;
    }

    if (cohort === "paid_course_purchaser") {
      const matchSpecificCourse = context.legacyRailsPlaylistId
        ? "AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.sellableId')) = ?"
        : "";
      const [rows] = await connection.execute<FixtureUserRow[]>(
        `
          SELECT entitlement.userId
          FROM egghead_Entitlement entitlement
          WHERE entitlement.deletedAt IS NULL
            AND entitlement.entitlementType = 'egghead_playlist_access'
            AND entitlement.sourceType = 'rails_sellable_purchase'
            AND entitlement.userId IS NOT NULL
            AND (entitlement.expiresAt IS NULL OR entitlement.expiresAt > CURRENT_TIMESTAMP(3))
            AND JSON_UNQUOTE(JSON_EXTRACT(entitlement.metadata, '$.sellableType')) = 'Playlist'
            ${matchSpecificCourse}
            AND NOT EXISTS (
              SELECT 1
              FROM egghead_Entitlement broad
              WHERE broad.userId = entitlement.userId
                AND broad.deletedAt IS NULL
                AND (broad.expiresAt IS NULL OR broad.expiresAt > CURRENT_TIMESTAMP(3))
                AND broad.entitlementType IN (
                  'egghead_all_access_subscription',
                  'egghead_lifetime_access',
                  'egghead_staff_special_access',
                  'egghead_membership_access'
                )
            )
          ORDER BY entitlement.id ASC
          LIMIT 1
        `,
        context.legacyRailsPlaylistId ? [String(context.legacyRailsPlaylistId)] : [],
      );

      return rows[0]?.userId ?? null;
    }

    if (cohort === "active_team_seat_learner" || cohort === "team_owner_admin") {
      const rolePredicate =
        cohort === "team_owner_admin"
          ? "membership.role = 'owner'"
          : "membership.role IN ('member', 'user')";
      const [rows] = await connection.execute<FixtureUserRow[]>(
        `
          SELECT membership.userId
          FROM egghead_Entitlement entitlement
          JOIN egghead_OrganizationMembership membership
            ON membership.organizationId = entitlement.organizationId
          WHERE entitlement.deletedAt IS NULL
            AND entitlement.entitlementType = 'egghead_all_access_subscription'
            AND entitlement.organizationId IS NOT NULL
            AND membership.userId IS NOT NULL
            AND (entitlement.expiresAt IS NULL OR entitlement.expiresAt > CURRENT_TIMESTAMP(3))
            AND ${rolePredicate}
          ORDER BY membership.id ASC
          LIMIT 1
        `,
      );

      return rows[0]?.userId ?? null;
    }

    if (cohort === "expired_canceled_subscriber") {
      const [rows] = await connection.execute<FixtureUserRow[]>(
        `
          SELECT expired.userId
          FROM egghead_Entitlement expired
          WHERE expired.entitlementType = 'egghead_all_access_subscription'
            AND expired.userId IS NOT NULL
            AND (
              expired.deletedAt IS NOT NULL
              OR expired.expiresAt <= CURRENT_TIMESTAMP(3)
            )
            AND NOT EXISTS (
              SELECT 1
              FROM egghead_Entitlement active
              WHERE active.userId = expired.userId
                AND active.deletedAt IS NULL
                AND (active.expiresAt IS NULL OR active.expiresAt > CURRENT_TIMESTAMP(3))
                AND active.entitlementType IN (
                  'egghead_all_access_subscription',
                  'egghead_lifetime_access',
                  'egghead_staff_special_access',
                  'egghead_membership_access',
                  'egghead_playlist_access'
                )
            )
          ORDER BY expired.id ASC
          LIMIT 1
        `,
      );

      return rows[0]?.userId ?? null;
    }

    if (cohort === "bare_legacy_pro_quarantined") {
      const [rows] = await connection.execute<FixtureUserRow[]>(
        `
          SELECT quarantine.userId
          FROM egghead_Entitlement quarantine
          WHERE quarantine.deletedAt IS NULL
            AND quarantine.entitlementType = 'egghead_legacy_pro_quarantine'
            AND quarantine.userId IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM egghead_Entitlement active
              WHERE active.userId = quarantine.userId
                AND active.deletedAt IS NULL
                AND (active.expiresAt IS NULL OR active.expiresAt > CURRENT_TIMESTAMP(3))
                AND active.entitlementType IN (
                  'egghead_all_access_subscription',
                  'egghead_lifetime_access',
                  'egghead_staff_special_access',
                  'egghead_membership_access',
                  'egghead_playlist_access'
                )
            )
          ORDER BY quarantine.id ASC
          LIMIT 1
        `,
      );

      return rows[0]?.userId ?? null;
    }

    if (cohort === "instructor_admin_support") {
      const [rows] = await connection.execute<FixtureUserRow[]>(
        `
          SELECT userId
          FROM egghead_Entitlement
          WHERE deletedAt IS NULL
            AND entitlementType = 'egghead_staff_special_access'
            AND sourceType = 'rails_user_role'
            AND userId IS NOT NULL
            AND (expiresAt IS NULL OR expiresAt > CURRENT_TIMESTAMP(3))
          ORDER BY id ASC
          LIMIT 1
        `,
      );

      return rows[0]?.userId ?? null;
    }

    const [rows] = await connection.execute<FixtureUserRow[]>(
      `
        SELECT localUser.id AS userId
        FROM egghead_User localUser
        WHERE NOT EXISTS (
          SELECT 1
          FROM egghead_Entitlement entitlement
          WHERE entitlement.userId = localUser.id
            AND entitlement.deletedAt IS NULL
            AND (entitlement.expiresAt IS NULL OR entitlement.expiresAt > CURRENT_TIMESTAMP(3))
        )
        ORDER BY localUser.id ASC
        LIMIT 1
      `,
    );

    return rows[0]?.userId ?? null;
  } finally {
    await connection.end();
  }
}

export function getCurrentUser() {
  return Promise.resolve(null);
}

export async function getCurrentUserFromRequest(
  request: Request,
  context: CurrentUserContext = {},
): Promise<CurrentUserReadModel> {
  const fixture = request.headers.get("x-egghead-mve-fixture");
  const rehearsalCohort = normalizeRehearsalCohort(
    request.headers.get("x-egghead-rehearsal-cohort") ?? fixture,
  );
  const authorization = request.headers.get("authorization");

  if (!rehearsalCohort && authorization) {
    return {
      localUserId: null,
      contentAccess: null,
      user: null,
      compatibility: {
        anonymousReturnsNullUser: true,
        invalidCredentialRejected: true,
      },
    };
  }

  if (!rehearsalCohort || rehearsalCohort === "anonymous") {
    return {
      localUserId: null,
      contentAccess: null,
      user: null,
      compatibility: rehearsalCohort
        ? {
            anonymousReturnsNullUser: true,
            rehearsalCohort,
          }
        : {
            anonymousReturnsNullUser: true,
          },
    };
  }

  const userId =
    fixture === "active-all-access-user"
      ? await findActiveAllAccessFixtureUserId()
      : await findRehearsalCohortUserId(rehearsalCohort, context);

  if (!userId) {
    return {
      localUserId: null,
      contentAccess: null,
      user: null,
      compatibility: {
        anonymousReturnsNullUser: true,
        invalidCredentialRejected: true,
        rehearsalCohort,
        rehearsalCohortUnavailable: true,
      },
    };
  }

  const access = await evaluateContentAccessForUser(
    context.legacyRailsPlaylistId === undefined
      ? { userId }
      : {
          userId,
          legacyRailsPlaylistId: context.legacyRailsPlaylistId,
        },
  );

  return {
    localUserId: userId,
    contentAccess: access,
    user: {
      id: hashUserId(userId),
      role: "user",
      identitySource: "coursebuilder-local-docker-fixture",
      cohort: rehearsalCohort,
      access,
      support: {
        accessSummary: access.granted ? access.reason : "denied:no_granting_entitlement",
      },
    },
    compatibility: {
      anonymousReturnsNullUser: true,
      fixtureSignedInUser: true,
      rehearsalCohort,
    },
  };
}
