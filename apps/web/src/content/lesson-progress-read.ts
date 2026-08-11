import { logger } from "@coursebuilder/core/utils/logger";

import { getCurrentUser } from "../coursebuilder/current-user";
import { readAnonymousCompletedLessonIds } from "../progress/anonymous-lesson-progress";
import { readCompletedResourceIdsForUser } from "../progress/resource-progress";

export type LessonProgressSnapshot = {
  initialCompletedLessonIds: string[];
  isAuthenticated: boolean;
};

export async function getLessonProgressSnapshot(
  resourceIds: readonly string[],
): Promise<LessonProgressSnapshot> {
  const user = await getCurrentUser();

  if (!user?.id) {
    const requestedResourceIds = new Set(resourceIds);
    const anonymousCompletedLessonIds = await readAnonymousCompletedLessonIds();

    return {
      initialCompletedLessonIds: anonymousCompletedLessonIds.filter((resourceId) =>
        requestedResourceIds.has(resourceId),
      ),
      isAuthenticated: false,
    };
  }

  try {
    return {
      initialCompletedLessonIds: await readCompletedResourceIdsForUser({
        userId: user.id,
        resourceIds,
      }),
      isAuthenticated: true,
    };
  } catch (error) {
    logger.error(
      error instanceof Error ? error : new Error("Unknown lesson progress read failure"),
      { operation: "readLessonProgressSnapshot" },
    );

    return {
      initialCompletedLessonIds: [],
      isAuthenticated: true,
    };
  }
}
