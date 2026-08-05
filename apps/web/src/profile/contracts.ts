import { z } from "zod";

const PUBLIC_PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const PUBLIC_AVATAR_HOSTS = new Set([
  "avatars.githubusercontent.com",
  "d2eip9sf3oo6c2.cloudfront.net",
  "gravatar.com",
  "res.cloudinary.com",
]);

export const profileNameSchema = z
  .string()
  .trim()
  .min(1, "Add a display name.")
  .max(80, "Keep your display name to 80 characters or fewer.");

export type ProfileCompletion = {
  resourceId: string;
  title: string;
  href: string;
  completedAt: Date;
};

export type PublicCompletion = {
  resourceId: string;
  title: string;
  href: string;
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
    completedCount: number;
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
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !PUBLIC_AVATAR_HOSTS.has(url.hostname.toLowerCase())
    ) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
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
    completedCount: number;
    activeMonthCount: number;
  },
): PublicLearnerProfile {
  const historyByMonth = new Map<string, CompletionHistoryMonth>();

  for (const completion of completions) {
    const key = monthKey(completion.completedAt);
    const publicCompletion = {
      resourceId: completion.resourceId,
      title: completion.title,
      href: completion.href,
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
      completedCount: totals?.completedCount ?? completions.length,
      activeMonthCount: totals?.activeMonthCount ?? history.length,
      history,
    },
  };
}
