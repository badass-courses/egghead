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

import {
  completeLessonProgress,
  uncompleteLessonProgress,
  type LessonProgressSource,
} from "./lesson-progress-action";

export type LessonProgressFeedback =
  | { status: "idle"; message: null }
  | { status: "saving"; message: "Saving lesson progress" }
  | { status: "completed"; message: "Lesson marked as watched" }
  | { status: "uncompleted"; message: "Lesson marked as unwatched" }
  | { status: "authentication_required"; message: "Sign in to save progress" }
  | { status: "invalid_resource"; message: "This lesson could not be marked as watched" }
  | { status: "failed"; message: "Lesson progress could not be saved" };

type LessonProgressContextValue = {
  completedLessonIds: ReadonlySet<string>;
  isAuthenticated: boolean;
  completeLesson: (resourceId: string, source?: LessonProgressSource) => Promise<void>;
  uncompleteLesson: (resourceId: string) => Promise<void>;
  feedbackForLesson: (resourceId: string) => LessonProgressFeedback;
  isLessonCompleted: (resourceId: string) => boolean;
};

const idleFeedback: LessonProgressFeedback = { status: "idle", message: null };

const LessonProgressContext = createContext<LessonProgressContextValue | null>(null);

export function LessonProgressProvider({
  children,
  initialCompletedLessonIds,
  isAuthenticated,
}: {
  children: ReactNode;
  initialCompletedLessonIds: string[];
  isAuthenticated: boolean;
}) {
  const [completedLessonIds, setCompletedLessonIds] = useState<ReadonlySet<string>>(
    () => new Set(initialCompletedLessonIds),
  );
  const [feedbackByLesson, setFeedbackByLesson] = useState<
    ReadonlyMap<string, LessonProgressFeedback>
  >(() => new Map());
  // Initial progress is mount-only; callers must remount with a new key for a new snapshot.
  const completedLessonIdsRef = useRef<ReadonlySet<string>>(completedLessonIds);

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
  }, []);

  const rollBackOptimisticCompletion = useCallback((resourceId: string) => {
    const next = new Set(completedLessonIdsRef.current);
    next.delete(resourceId);
    completedLessonIdsRef.current = next;
    setCompletedLessonIds(next);
  }, []);

  const completeLesson = useCallback(
    async (resourceId: string, source: LessonProgressSource = "lesson_progress_control") => {
      if (completedLessonIdsRef.current.has(resourceId)) return;

      if (!isAuthenticated) {
        setFeedback(resourceId, {
          status: "authentication_required",
          message: "Sign in to save progress",
        });
        return;
      }

      addOptimisticCompletion(resourceId);
      setFeedback(resourceId, { status: "saving", message: "Saving lesson progress" });

      try {
        const result = await completeLessonProgress({ resourceId, source });

        switch (result.status) {
          case "completed":
            setFeedback(resourceId, {
              status: "completed",
              message: "Lesson marked as watched",
            });
            return;
          case "authentication_required":
            rollBackOptimisticCompletion(resourceId);
            setFeedback(resourceId, {
              status: "authentication_required",
              message: "Sign in to save progress",
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
      }
    },
    [addOptimisticCompletion, isAuthenticated, rollBackOptimisticCompletion, setFeedback],
  );

  const uncompleteLesson = useCallback(
    async (resourceId: string) => {
      if (!completedLessonIdsRef.current.has(resourceId)) return;

      if (!isAuthenticated) {
        setFeedback(resourceId, {
          status: "authentication_required",
          message: "Sign in to save progress",
        });
        return;
      }

      rollBackOptimisticCompletion(resourceId);
      setFeedback(resourceId, { status: "saving", message: "Saving lesson progress" });

      try {
        const result = await uncompleteLessonProgress({ resourceId });

        switch (result.status) {
          case "uncompleted":
            setFeedback(resourceId, {
              status: "uncompleted",
              message: "Lesson marked as unwatched",
            });
            return;
          case "authentication_required":
            addOptimisticCompletion(resourceId);
            setFeedback(resourceId, {
              status: "authentication_required",
              message: "Sign in to save progress",
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
      }
    },
    [addOptimisticCompletion, isAuthenticated, rollBackOptimisticCompletion, setFeedback],
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

  return <LessonProgressContext.Provider value={value}>{children}</LessonProgressContext.Provider>;
}

export function useLessonProgress() {
  const context = useContext(LessonProgressContext);

  if (!context) {
    throw new Error("useLessonProgress must be used within a LessonProgressProvider");
  }

  return context;
}
