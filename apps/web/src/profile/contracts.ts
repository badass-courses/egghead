import { z } from "zod";

import type { PublicContentFamily } from "../content/routes";

// Public activity sharing is deferred. This is not a runtime approval flag.
export const PUBLIC_PROFILE_SHARING_ENABLED = false;

const PUBLIC_PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const PUBLIC_AVATAR_PATH_PREFIX_BY_HOST: Record<string, string | null> = {
  "avatars.githubusercontent.com": null,
  "d2eip9sf3oo6c2.cloudfront.net": null,
  "gravatar.com": "/avatar/",
  "res.cloudinary.com": null,
  "www.gravatar.com": "/avatar/",
};

export const profileNameSchema = z
  .string()
  .trim()
  .min(1, "Add a display name.")
  .max(80, "Keep your display name to 80 characters or fewer.");

export type ProfileCompletionFamily = "course" | "lesson" | PublicContentFamily;
export type ProfileCompletionFilter = "course" | "lesson";

export type ProfileCompletionCourse = {
  title: string;
  href: string;
};

export type ProfileCompletion = {
  resourceId: string;
  family: ProfileCompletionFamily;
  title: string;
  href: string;
  course: ProfileCompletionCourse | null;
  completedAt: Date;
};

export type PublicCompletion = {
  resourceId: string;
  family: ProfileCompletionFamily;
  title: string;
  href: string;
  course: ProfileCompletionCourse | null;
  completedAt: string;
};

export type CompletionHistoryMonth = {
  key: string;
  label: string;
  completions: PublicCompletion[];
};

export type PublicLearnerProfile = {
  publicId: string;
  displayName: string;
  avatarUrl: string | null;
  memberSince: string | null;
  learning: {
    lessonCount: number;
    courseCount: number;
    activeMonthCount: number;
    history: CompletionHistoryMonth[];
  };
};

export class ProfileAuthorizationError extends Error {
  constructor() {
    super("The signed-in user cannot access this private profile.");
    this.name = "ProfileAuthorizationError";
  }
}

export function requireProfileOwner(actorUserId: string | null, profileUserId: string) {
  if (!actorUserId || actorUserId !== profileUserId) {
    throw new ProfileAuthorizationError();
  }

  return profileUserId;
}

export function ownerScopedNameUpdate(input: {
  actorUserId: string | null;
  profileUserId: string;
  name: unknown;
}) {
  const userId = requireProfileOwner(input.actorUserId, input.profileUserId);

  return {
    userId,
    name: profileNameSchema.parse(input.name),
  };
}

export function parsePublicProfileId(value: string): string | null {
  return PUBLIC_PROFILE_ID_PATTERN.test(value) ? value : null;
}

export function safePublicAvatarUrl(value: string | null): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;

  try {
    const url = new URL(candidate.startsWith("//") ? `https:${candidate}` : candidate);
    const hostname = url.hostname.toLowerCase();
    const requiredPathPrefix = PUBLIC_AVATAR_PATH_PREFIX_BY_HOST[hostname];
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !Object.hasOwn(PUBLIC_AVATAR_PATH_PREFIX_BY_HOST, hostname) ||
      (requiredPathPrefix !== null &&
        requiredPathPrefix !== undefined &&
        !url.pathname.startsWith(requiredPathPrefix))
    ) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

const UTC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function utcDayNumber(date: Date) {
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / MILLISECONDS_PER_DAY,
  );
}

function utcDayNumberFromIsoDate(value: string) {
  if (!UTC_DAY_PATTERN.test(value)) return null;

  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    return null;
  }

  return Math.floor(timestamp / MILLISECONDS_PER_DAY);
}

export function currentLearningStreakDays(completionDays: readonly string[], today = new Date()) {
  const todayNumber = utcDayNumber(today);
  const completedDayNumbers = new Set<number>();

  for (const completionDay of completionDays) {
    const dayNumber = utcDayNumberFromIsoDate(completionDay);
    if (dayNumber !== null && dayNumber <= todayNumber) completedDayNumbers.add(dayNumber);
  }

  let cursor = completedDayNumbers.has(todayNumber)
    ? todayNumber
    : completedDayNumbers.has(todayNumber - 1)
      ? todayNumber - 1
      : null;
  let streak = 0;

  while (cursor !== null && completedDayNumbers.has(cursor)) {
    streak += 1;
    cursor -= 1;
  }

  return streak;
}

function monthKey(date: Date) {
  return `${String(date.getUTCFullYear())}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function projectPublicLearnerProfile(
  user: {
    id: string;
    name: string | null;
    image: string | null;
    createdAt: Date | null;
  },
  completions: readonly ProfileCompletion[],
  totals?: {
    lessonCount: number;
    courseCount: number;
    activeMonthCount: number;
  },
): PublicLearnerProfile {
  const historyByMonth = new Map<string, CompletionHistoryMonth>();

  for (const completion of completions) {
    const key = monthKey(completion.completedAt);
    const publicCompletion = {
      resourceId: completion.resourceId,
      family: completion.family,
      title: completion.title,
      href: completion.href,
      course: completion.course,
      completedAt: completion.completedAt.toISOString(),
    };
    const existing = historyByMonth.get(key);

    if (existing) {
      existing.completions.push(publicCompletion);
    } else {
      historyByMonth.set(key, {
        key,
        label: monthLabel(completion.completedAt),
        completions: [publicCompletion],
      });
    }
  }

  const history = [...historyByMonth.values()].toSorted((left, right) =>
    right.key.localeCompare(left.key),
  );

  return {
    publicId: user.id,
    displayName: user.name?.trim() || "Egghead learner",
    avatarUrl: safePublicAvatarUrl(user.image),
    memberSince: user.createdAt ? monthLabel(user.createdAt) : null,
    learning: {
      lessonCount:
        totals?.lessonCount ??
        completions.filter((completion) => completion.family === "lesson").length,
      courseCount:
        totals?.courseCount ??
        completions.filter((completion) => completion.family === "course").length,
      activeMonthCount: totals?.activeMonthCount ?? history.length,
      history,
    },
  };
}
