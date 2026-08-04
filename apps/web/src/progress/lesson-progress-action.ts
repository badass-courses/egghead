"use server";

import { getLessonById } from "../content/lesson";
import { getCurrentUser } from "../coursebuilder/current-user";
import { completeResourceForUser } from "./resource-progress";

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

export async function completeLessonProgress(input: {
  resourceId: string;
}): Promise<CompleteLessonProgressResult> {
  const user = await getCurrentUser();

  if (!user?.id) {
    return {
      status: "authentication_required",
      resourceId: input.resourceId,
      completedAt: null,
    };
  }

  if (!input.resourceId) {
    return {
      status: "invalid_resource",
      resourceId: input.resourceId,
      completedAt: null,
    };
  }

  try {
    const lesson = await getLessonById(input.resourceId);

    if (!lesson || lesson.id !== input.resourceId) {
      return {
        status: "invalid_resource",
        resourceId: input.resourceId,
        completedAt: null,
      };
    }

    const progress = await completeResourceForUser({
      userId: user.id,
      resourceId: lesson.id,
      source: "lesson_player_ended",
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
  } catch {
    return {
      status: "failed",
      resourceId: input.resourceId,
      completedAt: null,
    };
  }
}
