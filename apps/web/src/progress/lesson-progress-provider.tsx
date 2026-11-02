"use client";

import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useMemo,
  useOptimistic,
  useState,
  type ReactNode,
} from "react";

import { CourseCompletionReview } from "./course-completion-review";
import {
  setLessonCompletion,
  type LessonProgressSource,
  type SetLessonCompletionResult,
} from "./lesson-progress-action";

export type LessonProgressFeedback =
  | { status: "idle"; message: null }
  | { status: "saving"; message: "Saving lesson progress" }
  | { status: "completed"; message: "Lesson marked as watched" }
  | {
      status: "anonymous_completed";
      message: "Lesson watched. Sign in to keep your progress.";
    }
  | { status: "uncompleted"; message: "Lesson marked as unwatched" }
  | {
      status: "authentication_required" | "anonymous_limit_reached";
      message: "Sign in to keep learning";
    }
  | { status: "invalid_resource"; message: "This lesson could not be marked as watched" }
  | { status: "failed"; message: "Lesson progress could not be saved" }
  | {
      status: "course_completion_failed";
      message: "Lesson progress saved, but course completion could not be saved";
    };

export type LessonProgressCourse = {
  id: string;
  slug: string;
  title: string;
  lessonCount: number;
};

type LessonProgressContextValue = {
  completedLessonIds: ReadonlySet<string>;
  isAuthenticated: boolean;
  completeLesson: (resourceId: string, source?: LessonProgressSource) => void;
  uncompleteLesson: (resourceId: string) => void;
  feedbackForLesson: (resourceId: string) => LessonProgressFeedback;
  isLessonCompleted: (resourceId: string) => boolean;
};

type CompletionIntent = { resourceId: string; completed: boolean };

const idleFeedback: LessonProgressFeedback = { status: "idle", message: null };

function applyCompletionIntent(
  completedLessonIds: ReadonlySet<string>,
  intent: CompletionIntent,
): ReadonlySet<string> {
  const next = new Set(completedLessonIds);
  if (intent.completed) next.add(intent.resourceId);
  else next.delete(intent.resourceId);
  return next;
}

function feedbackForResult(
  result: SetLessonCompletionResult,
  completed: boolean,
): LessonProgressFeedback {
  switch (result.status) {
    case "saved":
      return completed
        ? { status: "completed", message: "Lesson marked as watched" }
        : { status: "uncompleted", message: "Lesson marked as unwatched" };
    case "anonymous_saved":
      return {
        status: "anonymous_completed",
        message: "Lesson watched. Sign in to keep your progress.",
      };
    case "course_sync_failed":
      return {
        status: "course_completion_failed",
        message: "Lesson progress saved, but course completion could not be saved",
      };
    case "anonymous_limit_reached":
    case "authentication_required":
      return { status: result.status, message: "Sign in to keep learning" };
    case "invalid_resource":
      return { status: "invalid_resource", message: "This lesson could not be marked as watched" };
    case "failed":
      return { status: "failed", message: "Lesson progress could not be saved" };
    default:
      result satisfies never;
      return { status: "failed", message: "Lesson progress could not be saved" };
  }
}

const LessonProgressContext = createContext<LessonProgressContextValue | null>(null);

/**
 * Shows server-owned lesson progress. `initialCompletedLessonIds` is the server
 * snapshot and the only source of truth: pending writes are layered on top
 * optimistically and fall away when the action's re-render arrives.
 */
export function LessonProgressProvider({
  children,
  course,
  initialCompletedLessonIds,
  isAuthenticated,
}: {
  children: ReactNode;
  course?: LessonProgressCourse;
  initialCompletedLessonIds: string[];
  isAuthenticated: boolean;
}) {
  const serverCompletedLessonIds = useMemo<ReadonlySet<string>>(
    () => new Set(initialCompletedLessonIds),
    [initialCompletedLessonIds],
  );
  const [completedLessonIds, addCompletionIntent] = useOptimistic(
    serverCompletedLessonIds,
    applyCompletionIntent,
  );
  const [feedbackByLesson, setFeedbackByLesson] = useState<
    ReadonlyMap<string, LessonProgressFeedback>
  >(() => new Map());
  const [isCourseReviewOpen, setIsCourseReviewOpen] = useState(false);
  const courseSlug = course?.slug;

  const setFeedback = useCallback((resourceId: string, feedback: LessonProgressFeedback) => {
    setFeedbackByLesson((current) => new Map(current).set(resourceId, feedback));
  }, []);

  const saveCompletion = useCallback(
    (resourceId: string, completed: boolean, source: LessonProgressSource) => {
      if (feedbackByLesson.get(resourceId)?.status === "saving") return;
      if (completedLessonIds.has(resourceId) === completed) return;

      setFeedback(resourceId, { status: "saving", message: "Saving lesson progress" });
      startTransition(async () => {
        addCompletionIntent({ resourceId, completed });

        let result: SetLessonCompletionResult;
        try {
          result = await setLessonCompletion({ resourceId, completed, source, courseSlug });
        } catch {
          result = { status: "failed", promptCourseReview: false };
        }

        setFeedback(resourceId, feedbackForResult(result, completed));
        if (result.promptCourseReview) setIsCourseReviewOpen(true);
      });
    },
    [addCompletionIntent, completedLessonIds, courseSlug, feedbackByLesson, setFeedback],
  );

  const completeLesson = useCallback(
    (resourceId: string, source: LessonProgressSource = "lesson_progress_control") =>
      saveCompletion(resourceId, true, source),
    [saveCompletion],
  );

  const uncompleteLesson = useCallback(
    (resourceId: string) => saveCompletion(resourceId, false, "lesson_progress_control"),
    [saveCompletion],
  );

  const isLessonCompleted = useCallback(
    (resourceId: string) => completedLessonIds.has(resourceId),
    [completedLessonIds],
  );

  const feedbackForLesson = useCallback(
    (resourceId: string) => feedbackByLesson.get(resourceId) ?? idleFeedback,
    [feedbackByLesson],
  );

  const value = useMemo<LessonProgressContextValue>(
    () => ({
      completedLessonIds,
      isAuthenticated,
      completeLesson,
      uncompleteLesson,
      feedbackForLesson,
      isLessonCompleted,
    }),
    [
      completedLessonIds,
      completeLesson,
      feedbackForLesson,
      isAuthenticated,
      isLessonCompleted,
      uncompleteLesson,
    ],
  );

  return (
    <LessonProgressContext.Provider value={value}>
      {children}
      {course ? (
        <CourseCompletionReview
          course={course}
          lessonCount={course.lessonCount}
          onClose={() => setIsCourseReviewOpen(false)}
          open={isCourseReviewOpen}
        />
      ) : null}
    </LessonProgressContext.Provider>
  );
}

export function useLessonProgress() {
  const context = useContext(LessonProgressContext);

  if (!context) {
    throw new Error("useLessonProgress must be used within a LessonProgressProvider");
  }

  return context;
}
