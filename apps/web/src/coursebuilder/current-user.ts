import { createHash } from "node:crypto";
import type { Session } from "next-auth";

import { evaluateContentAccessForUser, normalizeRequestCountry } from "../access/evaluate";
import { auth } from "../server/auth";

type CurrentUserContext = {
  legacyRailsPlaylistId?: number | null;
};

type UserRole = "admin" | "contributor" | "user";

type CurrentUserPayload = {
  id: string;
  role: UserRole;
  identitySource: "coursebuilder-authjs";
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
    authjsSession?: true;
    invalidCredentialRejected?: true;
  };
};

function hashUserId(userId: string) {
  return createHash("sha1").update(`coursebuilder-user:${userId}`).digest("hex").slice(0, 16);
}

function normalizeRole(role: unknown): UserRole {
  if (role === "admin" || role === "contributor") return role;

  return "user";
}

function requestCountryFromHeaders(headers: Headers): string | null {
  return normalizeRequestCountry(
    headers.get("x-vercel-ip-country") ?? headers.get("cf-ipcountry") ?? headers.get("x-country"),
  );
}

export async function getCurrentUser() {
  let session: Session | null = null;

  try {
    session = await auth();
  } catch {
    session = null;
  }

  return session?.user ?? null;
}

export async function getCurrentUserFromRequest(
  request: Request,
  context: CurrentUserContext = {},
): Promise<CurrentUserReadModel> {
  const sessionUser = await getCurrentUser();
  const requestCountry = requestCountryFromHeaders(request.headers);

  if (sessionUser?.id) {
    const access = await evaluateContentAccessForUser(
      context.legacyRailsPlaylistId === undefined
        ? { userId: sessionUser.id, requestCountry }
        : {
            userId: sessionUser.id,
            legacyRailsPlaylistId: context.legacyRailsPlaylistId,
            requestCountry,
          },
    );

    return {
      localUserId: sessionUser.id,
      contentAccess: access,
      user: {
        id: hashUserId(sessionUser.id),
        role: normalizeRole(sessionUser.role),
        identitySource: "coursebuilder-authjs",
        access,
        support: {
          accessSummary: access.granted ? access.reason : "denied:no_granting_entitlement",
        },
      },
      compatibility: {
        anonymousReturnsNullUser: true,
        authjsSession: true,
      },
    };
  }

  if (request.headers.get("authorization")) {
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

  return {
    localUserId: null,
    contentAccess: null,
    user: null,
    compatibility: {
      anonymousReturnsNullUser: true,
    },
  };
}
