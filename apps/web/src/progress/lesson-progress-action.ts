"use server";

import { logger } from "@coursebuilder/core/utils/logger";

import { getLessonById } from "../content/lesson";
import { getCurrentUser } from "../coursebuilder/current-user";
import { completeResourceForUser, uncompleteResourceForUser } from "./resource-progress";

export type LessonProgressSource = "lesson_player_ended" | "lesson_progress_control";

export type CompleteLessonProgressResult =
  | {
      status: "completed";
      resourceId: string;
      completedAt: string;
    }
  | {
      status: "authentication_required" | "invalid_resource" | "failed";
      resourceId: string;
      completedAt: null;
    };

export type UncompleteLessonProgressResult =
  | {
      status: "uncompleted";
      resourceId: string;
      completedAt: null;
    }
  | {
      status: "authentication_required" | "invalid_resource" | "failed";
      resourceId: string;
      completedAt: string | null;
    };

export async function completeLessonProgress(input: {
  resourceId: string;
  source: LessonProgressSource;
}): Promise<CompleteLessonProgressResult> {
  const resourceId = typeof input?.resourceId === "string" ? input.resourceId : "";
  const source =
    input?.source === "lesson_player_ended" ? "lesson_player_ended" : "lesson_progress_control";
  const user = await getCurrentUser();

  if (!user?.id) {
    return {
      status: "authentication_required",
      resourceId,
      completedAt: null,
    };
  }

  if (resourceId.length === 0) {
    return {
      status: "invalid_resource",
      resourceId,
      completedAt: null,
    };
  }

  try {
    const lesson = await getLessonById(resourceId);

    if (!lesson || lesson.id !== resourceId) {
      return {
        status: "invalid_resource",
        resourceId,
        completedAt: null,
      };
    }

    const progress = await completeResourceForUser({
      userId: user.id,
      resourceId: lesson.id,
      source,
    });

    if (!progress.state.completedAt) {
      return {
        status: "failed",
        resourceId: lesson.id,
        completedAt: null,
      };
    }

    return {
      status: "completed",
      resourceId: lesson.id,
      completedAt: progress.state.completedAt,
    };
  } catch (error) {
    logger.error(
      error instanceof Error ? error : new Error("Unknown lesson progress write failure"),
      { operation: "completeLessonProgress" },
    );

    return {
      status: "failed",
      resourceId,
      completedAt: null,
    };
  }
}

export async function uncompleteLessonProgress(input: {
  resourceId: string;
}): Promise<UncompleteLessonProgressResult> {
  const resourceId = typeof input?.resourceId === "string" ? input.resourceId : "";
  const user = await getCurrentUser();

  if (!user?.id) {
    return {
      status: "authentication_required",
      resourceId,
      completedAt: null,
    };
  }

  if (resourceId.length === 0) {
    return {
      status: "invalid_resource",
      resourceId,
      completedAt: null,
    };
  }

  try {
    const lesson = await getLessonById(resourceId);

    if (!lesson || lesson.id !== resourceId) {
      return {
        status: "invalid_resource",
        resourceId,
        completedAt: null,
      };
    }

    const progress = await uncompleteResourceForUser({
      userId: user.id,
      resourceId: lesson.id,
      source: "lesson_progress_control",
    });

    if (progress.state.completed) {
      return {
        status: "failed",
        resourceId: lesson.id,
        completedAt: progress.state.completedAt,
      };
    }

    return {
      status: "uncompleted",
      resourceId: lesson.id,
      completedAt: null,
    };
  } catch (error) {
    logger.error(
      error instanceof Error ? error : new Error("Unknown lesson progress removal failure"),
      { operation: "uncompleteLessonProgress" },
    );

    return {
      status: "failed",
      resourceId,
      completedAt: null,
    };
  }
}
