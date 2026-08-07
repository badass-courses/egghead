"use client";

import { useLessonProgress } from "../progress/lesson-progress-provider";

function WatchedIcon({ className }: { className: string }) {
  return (
    <svg
      aria-hidden
      className={className}
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

export function LessonProgressControl({ lessonResourceId }: { lessonResourceId: string }) {
  const { completeLesson, feedbackForLesson, isLessonCompleted, uncompleteLesson } =
    useLessonProgress();
  const isCompleted = isLessonCompleted(lessonResourceId);
  const isSaving = feedbackForLesson(lessonResourceId).status === "saving";

  function toggleLessonCompletion() {
    if (isCompleted) {
      void uncompleteLesson(lessonResourceId);
      return;
    }

    void completeLesson(lessonResourceId);
  }

  const label = isCompleted ? "Mark lesson as unwatched" : "Mark lesson as watched";

  return (
    <button
      aria-label={label}
      className={
        isCompleted
          ? "-mx-2 inline-grid size-11 shrink-0 place-items-center rounded-full text-sage-foreground transition-colors hover:bg-sage-wash focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
          : "group -mx-2 inline-grid size-11 shrink-0 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
      }
      data-progress-control={isCompleted ? "completed" : "incomplete"}
      disabled={isSaving}
      onClick={toggleLessonCompletion}
      title={label}
      type="button"
    >
      {isCompleted ? (
        <WatchedIcon className="size-5" />
      ) : (
        <span className="size-7 rounded-full border border-muted-foreground/60 transition-colors group-hover:border-sage-line" />
      )}
    </button>
  );
}

export function LessonProgressFeedback({ lessonResourceId }: { lessonResourceId: string }) {
  const { feedbackForLesson, isLessonCompleted } = useLessonProgress();
  const feedback = feedbackForLesson(lessonResourceId);
  const isCompleted = isLessonCompleted(lessonResourceId);
  const isVisuallyHidden =
    feedback.status === "idle" ||
    feedback.status === "saving" ||
    feedback.status === "completed" ||
    feedback.status === "uncompleted";
  const message = feedback.status === "idle" ? (isCompleted ? "Watched" : null) : feedback.message;

  return (
    <output
      aria-live="polite"
      className={
        isVisuallyHidden ? "sr-only" : "basis-full text-sm font-bold text-muted-foreground"
      }
      data-progress-status={
        feedback.status === "idle" && isCompleted ? "completed" : feedback.status
      }
    >
      {message}
    </output>
  );
}

export function LessonProgressStatus({ lessonResourceId }: { lessonResourceId: string }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <LessonProgressControl lessonResourceId={lessonResourceId} />
      <LessonProgressFeedback lessonResourceId={lessonResourceId} />
    </div>
  );
}
