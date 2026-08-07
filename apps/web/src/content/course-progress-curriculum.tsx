"use client";

import Link from "next/link";
import {
  ResourceListHeader,
  ResourceListHeaderEyebrow,
  ResourceListHeaderMeta,
  ResourceListHeaderTitle,
} from "@egghead/ui/resource-list";

import { useLessonProgress } from "../progress/lesson-progress-provider";
import type { CourseForPage } from "./course";
import { CourseCurriculum, courseDurationLabel } from "./course-lesson-list";

function useCourseProgress(course: CourseForPage) {
  const progress = useLessonProgress();
  const completedCount = course.lessons.reduce(
    (count, lesson) => count + Number(progress.completedLessonIds.has(lesson.id)),
    0,
  );

  return { ...progress, completedCount };
}

export function CoursePageProgressCurriculum({ course }: { course: CourseForPage }) {
  const { completedCount, completedLessonIds, isAuthenticated } = useCourseProgress(course);

  return (
    <>
      {isAuthenticated ? (
        <p
          aria-live="polite"
          className="m-0 text-xs font-extrabold text-muted-foreground"
          data-course-progress="watched"
        >
          {completedCount}/{course.lessons.length} watched
        </p>
      ) : null}
      <CourseCurriculum
        completedLessonIds={completedLessonIds}
        course={course}
        showProgress={isAuthenticated}
      />
    </>
  );
}

export function CourseLessonProgressNavigation({
  activeLessonSlug,
  course,
}: {
  activeLessonSlug: string;
  course: CourseForPage;
}) {
  const { completedCount, completedLessonIds, isAuthenticated } = useCourseProgress(course);
  const duration = courseDurationLabel(course.lessons);

  return (
    <aside
      className="relative order-3 min-w-0 min-[960px]:order-2"
      aria-label={`${course.title} lessons`}
    >
      <CourseCurriculum
        activeLessonSlug={activeLessonSlug}
        className="min-[960px]:absolute min-[960px]:inset-0 min-[960px]:rounded-l-none min-[960px]:border-l-0"
        completedLessonIds={completedLessonIds}
        course={course}
        header={
          <ResourceListHeader>
            <ResourceListHeaderEyebrow>Course</ResourceListHeaderEyebrow>
            <ResourceListHeaderTitle
              as={Link}
              className="text-inherit no-underline transition-colors hover:text-rust"
              href={course.canonicalPath}
              prefetch={true}
            >
              {course.title}
            </ResourceListHeaderTitle>
            <ResourceListHeaderMeta aria-live="polite">
              {isAuthenticated
                ? `${completedCount}/${course.lessons.length} watched`
                : `${course.lessonCount} ${course.lessonCount === 1 ? "lesson" : "lessons"}`}
              {duration ? ` · ${duration}` : null}
            </ResourceListHeaderMeta>
          </ResourceListHeader>
        }
        showProgress={isAuthenticated}
      />
    </aside>
  );
}
