"use server";

import { logger } from "@coursebuilder/core/utils/logger";
import { z } from "zod";

import { getCourseBySlug } from "../content/course";
import { getCurrentUser } from "../coursebuilder/current-user";
import { saveCourseReviewForUser, syncCourseProgressForUser } from "./course-progress";

const courseProgressInputSchema = z.object({
  courseId: z.string().min(1).max(255),
  courseSlug: z.string().min(1).max(255),
});

const courseReviewInputSchema = courseProgressInputSchema.extend({
  rating: z.number().int().min(1).max(7),
  comment: z.string().trim().max(2_000),
});

export type SyncCourseCompletionResult =
  | {
      status: "completed";
      courseId: string;
      completedAt: string;
      shouldPromptForReview: boolean;
    }
  | {
      status: "incomplete";
      courseId: string;
      completedAt: null;
      shouldPromptForReview: false;
    }
  | {
      status: "authentication_required" | "invalid_course" | "failed";
      courseId: string;
      completedAt: null;
      shouldPromptForReview: false;
    };

export type SubmitCourseReviewResult =
  | { status: "saved"; courseId: string }
  | {
      status:
        | "authentication_required"
        | "invalid_course"
        | "invalid_review"
        | "course_incomplete"
        | "failed";
      courseId: string;
    };

async function validatedCourse(input: { courseId: string; courseSlug: string }) {
  const course = await getCourseBySlug(input.courseSlug);
  return course?.id === input.courseId ? course : null;
}

export async function syncCourseCompletion(input: unknown): Promise<SyncCourseCompletionResult> {
  const parsed = courseProgressInputSchema.safeParse(input);
  const courseId = parsed.success ? parsed.data.courseId : "";
  const user = await getCurrentUser();

  if (!user?.id) {
    return {
      status: "authentication_required",
      courseId,
      completedAt: null,
      shouldPromptForReview: false,
    };
  }

  if (!parsed.success) {
    return {
      status: "invalid_course",
      courseId,
      completedAt: null,
      shouldPromptForReview: false,
    };
  }

  try {
    const course = await validatedCourse(parsed.data);

    if (!course) {
      return {
        status: "invalid_course",
        courseId,
        completedAt: null,
        shouldPromptForReview: false,
      };
    }

    const progress = await syncCourseProgressForUser({
      userId: user.id,
      courseId: course.id,
      lessonIds: course.lessons.map((lesson) => lesson.id),
    });

    if (!progress.completed || !progress.completedAt) {
      return {
        status: "incomplete",
        courseId: course.id,
        completedAt: null,
        shouldPromptForReview: false,
      };
    }

    return {
      status: "completed",
      courseId: course.id,
      completedAt: progress.completedAt,
      shouldPromptForReview: !progress.reviewSubmitted,
    };
  } catch (error) {
    logger.error(
      error instanceof Error ? error : new Error("Unknown course progress sync failure"),
      { operation: "syncCourseCompletion" },
    );

    return {
      status: "failed",
      courseId,
      completedAt: null,
      shouldPromptForReview: false,
    };
  }
}

export async function submitCourseReview(input: unknown): Promise<SubmitCourseReviewResult> {
  const parsed = courseReviewInputSchema.safeParse(input);
  const courseId = parsed.success ? parsed.data.courseId : "";
  const user = await getCurrentUser();

  if (!user?.id) {
    return { status: "authentication_required", courseId };
  }

  if (!parsed.success) {
    return { status: "invalid_review", courseId };
  }

  try {
    const course = await validatedCourse(parsed.data);
    if (!course) return { status: "invalid_course", courseId };

    const result = await saveCourseReviewForUser({
      userId: user.id,
      courseId: course.id,
      rating: parsed.data.rating,
      comment: parsed.data.comment,
    });

    switch (result.status) {
      case "saved":
        return { status: "saved", courseId: course.id };
      case "course_incomplete":
        return { status: "course_incomplete", courseId: course.id };
      case "missing_progress":
        return { status: "invalid_course", courseId: course.id };
      default:
        result satisfies never;
        return { status: "failed", courseId: course.id };
    }
  } catch (error) {
    logger.error(
      error instanceof Error ? error : new Error("Unknown course review write failure"),
      {
        operation: "submitCourseReview",
      },
    );

    return { status: "failed", courseId };
  }
}
