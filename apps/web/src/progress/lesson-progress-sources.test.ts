import { beforeEach, describe, expect, it, vi } from "vitest";

import { classifyProgressCandidate, EXPLICIT_UNCOMPLETE_SOURCES } from "./import";
import { setLessonCompletion } from "./lesson-progress-action";
import { LESSON_PROGRESS_SOURCES } from "./lesson-progress-sources";

/**
 * Ties the Rails progress import's "explicit learner un-complete" rule to the
 * real lesson toggle. `setLessonCompletion` runs for real; only its session,
 * lesson lookup, cache and the database writers are replaced, so the test
 * sees exactly the source the UI path stamps on the row.
 */
const writes = vi.hoisted(() => ({
  calls: [] as Array<{ completed: boolean; userId: string; resourceId: string; source: string }>,
}));

vi.mock("../coursebuilder/current-user", () => ({
  getCurrentUser: () => Promise.resolve({ id: "learner" }),
}));
vi.mock("../content/lesson", () => ({
  getLessonById: (id: string) => Promise.resolve({ id }),
}));
vi.mock("../content/course", () => ({
  getCourseBySlug: () => Promise.resolve(null),
}));
vi.mock("next/cache", () => ({ updateTag: () => undefined }));
vi.mock("./anonymous-lesson-progress", () => ({
  recordAnonymousLessonCompletion: () => Promise.resolve({ status: "recorded" }),
}));
vi.mock("./course-progress", () => ({
  syncCourseProgressForUser: () => Promise.resolve({ completed: false, reviewSubmitted: false }),
}));
vi.mock("./resource-progress", () => {
  const record =
    (completed: boolean) => (input: { userId: string; resourceId: string; source: string }) => {
      writes.calls.push({ completed, ...input });
      return Promise.resolve({ state: { completed } });
    };
  return {
    completeResourceForUser: record(true),
    uncompleteResourceForUser: record(false),
  };
});

const RAILS_COMPLETED = new Date(Date.UTC(2024, 0, 1));
const LEARNER_TOGGLED = new Date(Date.UTC(2026, 0, 1));

describe("lesson toggle sources and the Rails progress import", () => {
  beforeEach(() => {
    writes.calls.length = 0;
  });

  it("uses the UI's own source list", () => {
    expect(EXPLICIT_UNCOMPLETE_SOURCES).toBe(LESSON_PROGRESS_SOURCES);
  });

  it.each(LESSON_PROGRESS_SOURCES)(
    "an un-complete through setLessonCompletion with %s outranks an older Rails completion",
    async (source) => {
      const result = await setLessonCompletion({
        resourceId: "lesson_1",
        completed: false,
        source,
      });

      expect(result.status).toBe("saved");
      expect(writes.calls).toEqual([
        { completed: false, userId: "learner", resourceId: "lesson_1", source },
      ]);
      const stamped = writes.calls[0]?.source;
      expect(
        classifyProgressCandidate(
          { completedAt: RAILS_COMPLETED },
          { completedAt: null, updatedAt: LEARNER_TOGGLED, fields: { source: stamped } },
        ),
      ).toBe("kept_cb_newer");
    },
  );

  it("refuses any other source, so no unlisted learner path can stamp a row", async () => {
    const result = await setLessonCompletion({
      resourceId: "lesson_1",
      completed: false,
      source: "course_lessons_incomplete",
    });
    expect(result.status).toBe("invalid_resource");
    expect(writes.calls).toEqual([]);
  });
});
