"use client";

import { useLessonProgress } from "../progress/lesson-progress-provider";

function WatchedIcon() {
  return (
    <svg
      aria-hidden
      className="size-3"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.5"
      viewBox="0 0 12 10"
    >
      <path d="M1.5 5.5L4.5 8.5L10.5 1.5" />
    </svg>
  );
}

export function LessonProgressStatus({ lessonResourceId }: { lessonResourceId: string }) {
  const { feedbackForLesson, isLessonCompleted } = useLessonProgress();
  const feedback = feedbackForLesson(lessonResourceId);
  const isCompleted = isLessonCompleted(lessonResourceId);

  if (!isCompleted && feedback.status === "idle") return null;

  const message =
    feedback.status === "saving"
      ? "Saving watched lesson"
      : feedback.status === "completed" || (feedback.status === "idle" && isCompleted)
        ? "Watched"
        : feedback.message;

  return (
    <output
      aria-live="polite"
      className={
        isCompleted
          ? "mt-3 inline-flex items-center gap-1.5 rounded-full border border-sage-line bg-sage-wash px-2.5 py-1 text-xs font-extrabold text-sage-foreground"
          : "mt-3 text-sm font-bold text-muted-foreground"
      }
      data-progress-status={
        feedback.status === "idle" && isCompleted ? "completed" : feedback.status
      }
    >
      {isCompleted ? <WatchedIcon /> : null}
      {message}
    </output>
  );
}
