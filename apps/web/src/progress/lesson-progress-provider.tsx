"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { CourseCompletionReview } from "./course-completion-review";
import { syncCourseCompletion, type SyncCourseCompletionResult } from "./course-progress-action";
import {
  completeLessonProgress,
  uncompleteLessonProgress,
  type LessonProgressSource,
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
  lessonIds: string[];
};

type LessonProgressContextValue = {
  completedLessonIds: ReadonlySet<string>;
  isAuthenticated: boolean;
  completeLesson: (resourceId: string, source?: LessonProgressSource) => Promise<void>;
  uncompleteLesson: (resourceId: string) => Promise<void>;
  feedbackForLesson: (resourceId: string) => LessonProgressFeedback;
  isLessonCompleted: (resourceId: string) => boolean;
};

const idleFeedback: LessonProgressFeedback = { status: "idle", message: null };

function isCourseCompletionFailure(status: SyncCourseCompletionResult["status"]) {
  return status === "authentication_required" || status === "invalid_course" || status === "failed";
}

const LessonProgressContext = createContext<LessonProgressContextValue | null>(null);

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
  const [completedLessonIds, setCompletedLessonIds] = useState<ReadonlySet<string>>(
    () => new Set(initialCompletedLessonIds),
  );
  const [feedbackByLesson, setFeedbackByLesson] = useState<
    ReadonlyMap<string, LessonProgressFeedback>
  >(() => new Map());
  const [isCourseReviewOpen, setIsCourseReviewOpen] = useState(false);
  // Initial progress is mount-only; callers must remount with a new key for a new snapshot.
  const completedLessonIdsRef = useRef<ReadonlySet<string>>(completedLessonIds);
  const inFlightLessonIdsRef = useRef<Set<string>>(new Set());
  const courseSyncRetryLessonIdsRef = useRef<Set<string>>(new Set());

  const setFeedback = useCallback((resourceId: string, feedback: LessonProgressFeedback) => {
    setFeedbackByLesson((current) => {
      const next = new Map(current);
      next.set(resourceId, feedback);
      return next;
    });
  }, []);

  const addOptimisticCompletion = useCallback((resourceId: string) => {
    const next = new Set(completedLessonIdsRef.current);
    next.add(resourceId);
    completedLessonIdsRef.current = next;
    setCompletedLessonIds(next);
    return next;
  }, []);

  const rollBackOptimisticCompletion = useCallback((resourceId: string) => {
    const next = new Set(completedLessonIdsRef.current);
    next.delete(resourceId);
    completedLessonIdsRef.current = next;
    setCompletedLessonIds(next);
    return next;
  }, []);

  const completeLesson = useCallback(
    async (resourceId: string, source: LessonProgressSource = "lesson_progress_control") => {
      if (inFlightLessonIdsRef.current.has(resourceId)) {
        return;
      }

      if (completedLessonIdsRef.current.has(resourceId)) {
        if (!course || !courseSyncRetryLessonIdsRef.current.has(resourceId)) return;

        inFlightLessonIdsRef.current.add(resourceId);
        setFeedback(resourceId, { status: "saving", message: "Saving lesson progress" });

        try {
          const courseResult = await syncCourseCompletion({
            courseId: course.id,
            courseSlug: course.slug,
          });

          if (isCourseCompletionFailure(courseResult.status)) {
            setFeedback(resourceId, {
              status: "course_completion_failed",
              message: "Lesson progress saved, but course completion could not be saved",
            });
            return;
          }

          courseSyncRetryLessonIdsRef.current.delete(resourceId);
          if (courseResult.status === "completed" && courseResult.shouldPromptForReview) {
            setIsCourseReviewOpen(true);
          }
          setFeedback(resourceId, {
            status: "completed",
            message: "Lesson marked as watched",
          });
        } catch {
          setFeedback(resourceId, {
            status: "course_completion_failed",
            message: "Lesson progress saved, but course completion could not be saved",
          });
        } finally {
          inFlightLessonIdsRef.current.delete(resourceId);
        }
        return;
      }

      if (!isAuthenticated && source !== "lesson_player_ended") {
        setFeedback(resourceId, {
          status: "authentication_required",
          message: "Sign in to keep learning",
        });
        return;
      }

      inFlightLessonIdsRef.current.add(resourceId);
      const nextCompletedLessonIds = addOptimisticCompletion(resourceId);
      const completesCourse =
        course !== undefined &&
        course.lessonIds.length > 0 &&
        course.lessonIds.every((lessonId) => nextCompletedLessonIds.has(lessonId));
      setFeedback(resourceId, { status: "saving", message: "Saving lesson progress" });

      try {
        const result = await completeLessonProgress({ resourceId, source });

        switch (result.status) {
          case "completed": {
            if (completesCourse && course) {
              const courseResult = await syncCourseCompletion({
                courseId: course.id,
                courseSlug: course.slug,
              });

              if (isCourseCompletionFailure(courseResult.status)) {
                courseSyncRetryLessonIdsRef.current.add(resourceId);
                setFeedback(resourceId, {
                  status: "course_completion_failed",
                  message: "Lesson progress saved, but course completion could not be saved",
                });
                return;
              }

              courseSyncRetryLessonIdsRef.current.delete(resourceId);
              if (courseResult.status === "completed" && courseResult.shouldPromptForReview) {
                setIsCourseReviewOpen(true);
              }
            }

            setFeedback(resourceId, {
              status: "completed",
              message: "Lesson marked as watched",
            });
            return;
          }
          case "anonymous_completed":
            setFeedback(resourceId, {
              status: "anonymous_completed",
              message: "Lesson watched. Sign in to keep your progress.",
            });
            return;
          case "anonymous_limit_reached":
            rollBackOptimisticCompletion(resourceId);
            setFeedback(resourceId, {
              status: "anonymous_limit_reached",
              message: "Sign in to keep learning",
            });
            return;
          case "authentication_required":
            rollBackOptimisticCompletion(resourceId);
            setFeedback(resourceId, {
              status: "authentication_required",
              message: "Sign in to keep learning",
            });
            return;
          case "invalid_resource":
            rollBackOptimisticCompletion(resourceId);
            setFeedback(resourceId, {
              status: "invalid_resource",
              message: "This lesson could not be marked as watched",
            });
            return;
          case "failed":
            rollBackOptimisticCompletion(resourceId);
            setFeedback(resourceId, {
              status: "failed",
              message: "Lesson progress could not be saved",
            });
            return;
          default:
            result satisfies never;
            rollBackOptimisticCompletion(resourceId);
            setFeedback(resourceId, {
              status: "failed",
              message: "Lesson progress could not be saved",
            });
            return;
        }
      } catch {
        rollBackOptimisticCompletion(resourceId);
        setFeedback(resourceId, {
          status: "failed",
          message: "Lesson progress could not be saved",
        });
      } finally {
        inFlightLessonIdsRef.current.delete(resourceId);
      }
    },
    [addOptimisticCompletion, course, isAuthenticated, rollBackOptimisticCompletion, setFeedback],
  );

  const uncompleteLesson = useCallback(
    async (resourceId: string) => {
      if (
        !completedLessonIdsRef.current.has(resourceId) ||
        inFlightLessonIdsRef.current.has(resourceId)
      ) {
        return;
      }

      if (!isAuthenticated) {
        setFeedback(resourceId, {
          status: "authentication_required",
          message: "Sign in to keep learning",
        });
        return;
      }

      const courseWasCompleted =
        course !== undefined &&
        course.lessonIds.length > 0 &&
        course.lessonIds.every((lessonId) => completedLessonIdsRef.current.has(lessonId));
      inFlightLessonIdsRef.current.add(resourceId);
      rollBackOptimisticCompletion(resourceId);
      setFeedback(resourceId, { status: "saving", message: "Saving lesson progress" });

      try {
        const result = await uncompleteLessonProgress({ resourceId });

        switch (result.status) {
          case "uncompleted": {
            courseSyncRetryLessonIdsRef.current.delete(resourceId);
            if (courseWasCompleted && course) {
              const courseResult = await syncCourseCompletion({
                courseId: course.id,
                courseSlug: course.slug,
              });

              if (isCourseCompletionFailure(courseResult.status)) {
                setFeedback(resourceId, {
                  status: "course_completion_failed",
                  message: "Lesson progress saved, but course completion could not be saved",
                });
                return;
              }
            }

            setFeedback(resourceId, {
              status: "uncompleted",
              message: "Lesson marked as unwatched",
            });
            return;
          }
          case "authentication_required":
            addOptimisticCompletion(resourceId);
            setFeedback(resourceId, {
              status: "authentication_required",
              message: "Sign in to keep learning",
            });
            return;
          case "invalid_resource":
            addOptimisticCompletion(resourceId);
            setFeedback(resourceId, {
              status: "invalid_resource",
              message: "This lesson could not be marked as watched",
            });
            return;
          case "failed":
            addOptimisticCompletion(resourceId);
            setFeedback(resourceId, {
              status: "failed",
              message: "Lesson progress could not be saved",
            });
            return;
          default:
            result satisfies never;
            addOptimisticCompletion(resourceId);
            setFeedback(resourceId, {
              status: "failed",
              message: "Lesson progress could not be saved",
            });
            return;
        }
      } catch {
        addOptimisticCompletion(resourceId);
        setFeedback(resourceId, {
          status: "failed",
          message: "Lesson progress could not be saved",
        });
      } finally {
        inFlightLessonIdsRef.current.delete(resourceId);
      }
    },
    [addOptimisticCompletion, course, isAuthenticated, rollBackOptimisticCompletion, setFeedback],
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
          lessonCount={course.lessonIds.length}
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
