import { cookies } from "next/headers";

import { getLessonById } from "../content/lesson";
import { completeResourcesForUser } from "./resource-progress";

export const ANONYMOUS_LESSON_LIMIT = 3;

const ANONYMOUS_LESSON_COOKIE = "egghead-anonymous-completions-v1";
const ANONYMOUS_LESSON_COOKIE_MAX_AGE = 60 * 60 * 24 * 15;

type AnonymousCompletionWriteResult = {
  status: "recorded" | "limit_reached";
};

function parseAnonymousLessonIds(value: string | undefined): string[] {
  if (!value) return [];

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];

    return [
      ...new Set(
        parsed.filter(
          (resourceId): resourceId is string =>
            typeof resourceId === "string" && resourceId.length > 0,
        ),
      ),
    ].slice(0, ANONYMOUS_LESSON_LIMIT);
  } catch {
    return [];
  }
}

export async function readAnonymousCompletedLessonIds(): Promise<string[]> {
  const cookieStore = await cookies();
  return parseAnonymousLessonIds(cookieStore.get(ANONYMOUS_LESSON_COOKIE)?.value);
}

// Anonymous progress is best-effort: response cookie writes cannot be merged atomically across
// tabs, so simultaneous completions may race. Authenticated progress remains database-backed.
export async function recordAnonymousLessonCompletion(
  resourceId: string,
): Promise<AnonymousCompletionWriteResult> {
  const cookieStore = await cookies();
  const completedLessonIds = parseAnonymousLessonIds(
    cookieStore.get(ANONYMOUS_LESSON_COOKIE)?.value,
  );

  if (completedLessonIds.includes(resourceId)) {
    return { status: "recorded" };
  }

  if (completedLessonIds.length >= ANONYMOUS_LESSON_LIMIT) {
    return { status: "limit_reached" };
  }

  const nextCompletedLessonIds = [...completedLessonIds, resourceId];
  cookieStore.set(ANONYMOUS_LESSON_COOKIE, JSON.stringify(nextCompletedLessonIds), {
    httpOnly: true,
    maxAge: ANONYMOUS_LESSON_COOKIE_MAX_AGE,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  return { status: "recorded" };
}

export async function anonymousLessonAccess(resourceId: string) {
  const completedLessonIds = await readAnonymousCompletedLessonIds();

  return {
    canWatch:
      completedLessonIds.length < ANONYMOUS_LESSON_LIMIT || completedLessonIds.includes(resourceId),
  };
}

export async function claimAnonymousLessonCompletions(userId: string) {
  const cookieStore = await cookies();
  const completedLessonIds = parseAnonymousLessonIds(
    cookieStore.get(ANONYMOUS_LESSON_COOKIE)?.value,
  );

  if (completedLessonIds.length === 0) {
    return { claimedLessonIds: [] };
  }

  const lessons = await Promise.all(
    completedLessonIds.map((resourceId) => getLessonById(resourceId)),
  );
  const validLessonIds = lessons.flatMap((lesson, index) => {
    const resourceId = completedLessonIds[index];
    return lesson && resourceId && lesson.id === resourceId ? [resourceId] : [];
  });

  if (validLessonIds.length > 0) {
    await completeResourcesForUser({
      userId,
      resourceIds: validLessonIds,
      source: "anonymous_cookie_claim",
    });
  }

  cookieStore.delete(ANONYMOUS_LESSON_COOKIE);

  return { claimedLessonIds: validLessonIds };
}
