import { getCurrentUser } from "../coursebuilder/current-user";
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
    return {
      initialCompletedLessonIds: [],
      isAuthenticated: false,
    };
  }

  return {
    initialCompletedLessonIds: await readCompletedResourceIdsForUser({
      userId: user.id,
      resourceIds,
    }),
    isAuthenticated: true,
  };
}
