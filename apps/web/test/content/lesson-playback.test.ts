import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  end: vi.fn(),
  currentUser: vi.fn(),
  currentUserFromRequest: vi.fn(),
  anonymousAccess: vi.fn(),
}));

vi.mock("next/cache", () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("../../src/db/local-docker", () => ({
  createLocalMysqlConnection: async () => ({ execute: mocks.execute, end: mocks.end }),
}));
vi.mock("../../src/coursebuilder/current-user", () => ({
  getCurrentUser: mocks.currentUser,
  getCurrentUserFromRequest: mocks.currentUserFromRequest,
}));
vi.mock("../../src/progress/anonymous-lesson-progress", () => ({
  ANONYMOUS_LESSON_LIMIT: 3,
  anonymousLessonAccess: mocks.anonymousAccess,
}));
vi.mock("../../src/content/lesson-html-video", () => ({
  LessonHtmlVideo: () => "lesson-video",
}));
vi.mock("../../src/content/lesson-mux-player", () => ({ LessonMuxPlayer: () => "mux-video" }));
vi.mock("../../src/progress/lesson-progress-provider", () => ({ LessonProgressProvider: vi.fn() }));
vi.mock("../../src/content/course-lesson-list", () => ({
  CourseCurriculum: vi.fn(),
  courseDurationLabel: vi.fn(),
}));
vi.mock("../../src/content/lesson-progress-read", () => ({ getLessonProgressSnapshot: vi.fn() }));
vi.mock("../../src/content/lesson-progress-status", () => ({ LessonProgressStatus: vi.fn() }));
vi.mock("../../src/content/mux-player-context", () => ({ MuxPlayerProvider: vi.fn() }));
vi.mock("../../src/content/lesson-transcript", () => ({ getLessonVideoTranscript: vi.fn() }));
vi.mock("../../src/content/lesson-transcript-renderer", () => ({ LessonTranscriptBody: vi.fn() }));
vi.mock("../../src/content/markdown-content", () => ({ MarkdownContent: vi.fn() }));

import type { JsonFields } from "../../src/content/fields";
import { getLessonById } from "../../src/content/lesson";
import { LessonPlayerExperience } from "../../src/content/lesson-page";

beforeEach(() => {
  vi.clearAllMocks();
  // Match Next's automatic JSX runtime when Vitest uses the classic transform.
  vi.stubGlobal("React", React);
  mocks.currentUser.mockResolvedValue(null);
  mocks.currentUserFromRequest.mockResolvedValue({
    contentAccess: { granted: false, reason: "denied" },
  });
  mocks.anonymousAccess.mockResolvedValue({ canWatch: true });
});

async function playback(fields: JsonFields, courseLinked = false) {
  const lessonRow = {
    id: "synthetic-lesson",
    type: fields["postType"] ? "post" : "lesson",
    fields: {
      slug: "synthetic-lesson",
      title: "Synthetic lesson",
      videoUrl: "https://example.com/video.m3u8",
      ...fields,
    },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  mocks.execute
    .mockResolvedValueOnce([[lessonRow]])
    .mockResolvedValueOnce([
      courseLinked
        ? [
            {
              ...lessonRow,
              id: "synthetic-course",
              type: "course",
              fields: { slug: "synthetic-course" },
            },
          ]
        : [],
    ])
    .mockResolvedValueOnce([[]]);
  const lesson = await getLessonById("synthetic-lesson");
  if (!lesson) throw new Error("Expected synthetic lesson");
  const html = renderToStaticMarkup(await LessonPlayerExperience({ lesson }));
  return { html, lesson };
}

for (const fields of [
  { isProContent: true },
  { is_pro_content: true },
  { freeAccess: false },
  { postType: "lesson", access: "pro" },
]) {
  it(`gates standalone ${JSON.stringify(fields)} signed out and opens it to a paying user`, async () => {
    const denied = await playback(fields);
    expect(denied.lesson.courseLinked).toBe(false);
    expect(denied.lesson.isProContent).toBe(true);
    expect(denied.html).toContain('data-video-state="gated"');
    expect(denied.html).not.toContain("lesson-video");
    expect(mocks.anonymousAccess).not.toHaveBeenCalled();

    mocks.currentUserFromRequest.mockResolvedValue({
      contentAccess: { granted: true, reason: "subscription" },
    });
    const allowed = await playback(fields);
    expect(allowed.html).toContain("lesson-video");
    expect(allowed.html).not.toContain('data-video-state="gated"');
    expect(mocks.currentUserFromRequest).toHaveBeenCalledTimes(2);
  });
}

it("keeps an author-free standalone CB lesson post on the free path", async () => {
  const { html } = await playback({ postType: "lesson", access: "free" });
  expect(html).toContain("lesson-video");
  expect(mocks.currentUserFromRequest).not.toHaveBeenCalled();
  expect(mocks.anonymousAccess).toHaveBeenCalledWith("synthetic-lesson");
});

it("preserves author-free CB course posts without consulting duplicate Rails rows", async () => {
  const { html, lesson } = await playback({ postType: "lesson", access: "free" }, true);
  expect(lesson.courseLinked).toBe(true);
  expect(lesson.freeForever).toBe(true);
  expect(html).toContain("lesson-video");
  expect(mocks.currentUserFromRequest).not.toHaveBeenCalled();
  expect(mocks.execute).toHaveBeenCalledTimes(3);
});

it("keeps a free-forever course lesson on the free path even with older pro intent", async () => {
  const { html, lesson } = await playback({ isProContent: false, freeAccess: false }, true);
  expect(lesson.courseLinked).toBe(true);
  expect(lesson.freeForever).toBe(true);
  expect(html).toContain("lesson-video");
  expect(mocks.currentUserFromRequest).not.toHaveBeenCalled();
});
