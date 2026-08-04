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

import { completeLessonProgress } from "./lesson-progress-action";

export type LessonProgressFeedback =
  | { status: "idle"; message: null }
  | { status: "saving"; message: "Saving lesson progress" }
  | { status: "completed"; message: "Lesson marked as watched" }
  | { status: "authentication_required"; message: "Sign in to save progress" }
  | { status: "invalid_resource"; message: "This lesson could not be marked as watched" }
  | { status: "failed"; message: "Lesson progress could not be saved" };

type LessonProgressContextValue = {
  completedLessonIds: ReadonlySet<string>;
  isAuthenticated: boolean;
  completeLesson: (resourceId: string) => Promise<void>;
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
  const completedLessonIdsRef = useRef(new Set(initialCompletedLessonIds));

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
    async (resourceId: string) => {
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
        const result = await completeLessonProgress({ resourceId });

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
      feedbackForLesson,
      isLessonCompleted,
    }),
    [completedLessonIds, completeLesson, feedbackForLesson, isAuthenticated, isLessonCompleted],
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
