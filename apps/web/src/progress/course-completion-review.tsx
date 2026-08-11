"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@egghead/ui/button";

import { submitCourseReview } from "./course-progress-action";

const RATINGS = [1, 2, 3, 4, 5, 6, 7] as const;

type SubmissionState = "idle" | "saving" | "saved" | "failed";

export function CourseCompletionReview({
  course,
  lessonCount,
  onClose,
  open,
}: {
  course: { id: string; slug: string; title: string };
  lessonCount: number;
  onClose: () => void;
  open: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [submission, setSubmission] = useState<SubmissionState>("idle");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
      dialog.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  async function submitReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (rating === null || submission === "saving") return;

    setSubmission("saving");

    try {
      const result = await submitCourseReview({
        courseId: course.id,
        courseSlug: course.slug,
        rating,
        comment,
      });
      setSubmission(result.status === "saved" ? "saved" : "failed");
    } catch {
      setSubmission("failed");
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="course-review-title"
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(36rem,calc(100%-2rem))] overflow-y-auto rounded-2xl bg-surface p-0 text-foreground shadow-card-deep focus:outline-none backdrop:bg-navy/80"
      tabIndex={-1}
      onCancel={onClose}
      onClose={onClose}
    >
      <header className="px-gutter pt-7">
        <h2 className="m-0 text-balance text-2xl font-black" id="course-review-title">
          {submission === "saved" ? "Review saved" : "How was this course?"}
        </h2>
        {submission === "saved" ? null : (
          <p className="mb-0 mt-2 text-sm text-muted-foreground">
            {course.title} · {lessonCount} {lessonCount === 1 ? "lesson" : "lessons"} watched
          </p>
        )}
      </header>

      {submission === "saved" ? (
        <div className="grid justify-items-start gap-6 px-gutter pb-7 pt-3">
          <p className="m-0 max-w-prose text-muted-foreground">
            Thanks. Your feedback helps us improve the course.
          </p>
          <Button onClick={onClose}>Done</Button>
        </div>
      ) : (
        <form className="grid gap-6 px-gutter pb-7 pt-6" onSubmit={submitReview}>
          <fieldset className="m-0 min-w-0 border-0 p-0">
            <legend className="mb-3 text-sm font-extrabold">Your rating</legend>
            <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
              {RATINGS.map((value) => (
                <label className="cursor-pointer" key={value}>
                  <input
                    aria-label={`Rate course ${value} out of 7`}
                    checked={rating === value}
                    className="peer sr-only"
                    name="course-rating"
                    onChange={() => {
                      setRating(value);
                      setSubmission("idle");
                    }}
                    required
                    type="radio"
                    value={value}
                  />
                  <span className="grid aspect-square place-items-center rounded-lg border border-border-strong bg-surface text-base font-black transition-colors hover:bg-well peer-checked:border-foreground peer-checked:bg-foreground peer-checked:text-background peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring sm:text-lg">
                    {value}
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-2 flex justify-between text-xs font-bold text-muted-foreground">
              <span>Not useful</span>
              <span>Excellent</span>
            </div>
          </fieldset>

          <div>
            <label className="text-sm font-extrabold" htmlFor="course-review-comment">
              Anything else? <span className="font-normal text-muted-foreground">Optional</span>
            </label>
            <textarea
              aria-describedby={comment.length > 1_800 ? "course-review-comment-count" : undefined}
              aria-label="Course review comment"
              className="mt-2 min-h-28 w-full resize-y rounded-xl border border-border-strong bg-surface px-4 py-3 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              id="course-review-comment"
              maxLength={2_000}
              onChange={(event) => {
                setComment(event.target.value);
                setSubmission("idle");
              }}
              placeholder="What worked? What could be clearer?"
              value={comment}
            />
            {comment.length > 1_800 ? (
              <p
                className="mb-0 mt-1 text-right text-xs text-muted-foreground"
                id="course-review-comment-count"
              >
                {comment.length}/2,000
              </p>
            ) : null}
          </div>

          {submission === "failed" ? (
            <p className="m-0 text-sm font-bold text-rust" role="alert">
              We couldn’t save your review. Try again.
            </p>
          ) : null}

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
            <button
              className="rounded-lg px-4 py-3 text-sm font-extrabold text-muted-foreground transition-colors hover:text-foreground"
              disabled={submission === "saving"}
              onClick={onClose}
              type="button"
            >
              Not now
            </button>
            <Button disabled={rating === null || submission === "saving"} type="submit">
              {submission === "saving" ? "Saving…" : "Save review"}
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}
