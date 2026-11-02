"use server";

import { logger } from "@coursebuilder/utils/logger";
import { updateTag } from "next/cache";
import { z } from "zod";

import { getCourseBySlug } from "../content/course";
import { getLessonById } from "../content/lesson";
import { getCurrentUser } from "../coursebuilder/current-user";
import { recordAnonymousLessonCompletion } from "./anonymous-lesson-progress";
import { syncCourseProgressForUser } from "./course-progress";
import { completeResourceForUser, uncompleteResourceForUser } from "./resource-progress";

export type LessonProgressSource = "lesson_player_ended" | "lesson_progress_control";

const setLessonCompletionInputSchema = z.object({
  resourceId: z.string().min(1).max(255),
  completed: z.boolean(),
  source: z.enum(["lesson_player_ended", "lesson_progress_control"]),
  courseSlug: z.string().min(1).max(255).optional(),
});

export type SetLessonCompletionInput = z.infer<typeof setLessonCompletionInputSchema>;

export type SetLessonCompletionResult =
  | { status: "saved"; promptCourseReview: boolean }
  | {
      status:
        | "anonymous_saved"
        | "course_sync_failed"
        | "anonymous_limit_reached"
        | "authentication_required"
        | "invalid_resource"
        | "failed";
      promptCourseReview: false;
    };

function result(status: Exclude<SetLessonCompletionResult["status"], "saved">) {
  return { status, promptCourseReview: false } satisfies SetLessonCompletionResult;
}

// Course and lesson links prefetch full payloads, including the progress
// snapshot. A tag update (unlike `refresh()`) evicts the client prefetch cache
// and re-renders the current page in this action's response. Anonymous writes
// set a cookie, which Next already treats the same way.
function evictProgressSnapshots(userId: string) {
  updateTag(`lesson-progress:${userId}`);
}

/**
 * Records a lesson as watched or unwatched. When the lesson is viewed inside a
 * course, the course completion row is recounted here so the server alone
 * decides course completion.
 */
export async function setLessonCompletion(input: unknown): Promise<SetLessonCompletionResult> {
  const parsed = setLessonCompletionInputSchema.safeParse(input);
  if (!parsed.success) return result("invalid_resource");

  const { completed, courseSlug, resourceId, source } = parsed.data;

  try {
    const [user, lesson] = await Promise.all([getCurrentUser(), getLessonById(resourceId)]);

    if (!lesson || lesson.id !== resourceId) return result("invalid_resource");

    if (!user?.id) {
      if (!completed || source !== "lesson_player_ended") {
        return result("authentication_required");
      }

      const anonymousCompletion = await recordAnonymousLessonCompletion(lesson.id);
      return result(
        anonymousCompletion.status === "limit_reached"
          ? "anonymous_limit_reached"
          : "anonymous_saved",
      );
    }

    const progress = completed
      ? await completeResourceForUser({ userId: user.id, resourceId: lesson.id, source })
      : await uncompleteResourceForUser({ userId: user.id, resourceId: lesson.id, source });

    if (progress.state.completed !== completed) return result("failed");

    evictProgressSnapshots(user.id);

    if (!courseSlug) return { status: "saved", promptCourseReview: false };

    try {
      const course = await getCourseBySlug(courseSlug);
      if (!course?.lessons.some((courseLesson) => courseLesson.id === lesson.id)) {
        return { status: "saved", promptCourseReview: false };
      }

      const courseProgress = await syncCourseProgressForUser({
        userId: user.id,
        courseId: course.id,
        lessonIds: course.lessons.map((courseLesson) => courseLesson.id),
      });

      return {
        status: "saved",
        promptCourseReview:
          completed && courseProgress.completed && !courseProgress.reviewSubmitted,
      };
    } catch (error) {
      logger.error(
        error instanceof Error ? error : new Error("Unknown course progress sync failure"),
        { operation: "setLessonCompletion.syncCourseProgress" },
      );
      return result("course_sync_failed");
    }
  } catch (error) {
    logger.error(
      error instanceof Error ? error : new Error("Unknown lesson progress write failure"),
      { operation: "setLessonCompletion" },
    );
    return result("failed");
  }
}
