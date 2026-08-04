import Link from "next/link";
import type { ReactNode } from "react";
import {
  ResourceList,
  ResourceListBadge,
  ResourceListCard,
  ResourceListIndicator,
  ResourceListItem,
  ResourceListLink,
  ResourceListMeta,
  ResourceListSection,
  ResourceListSectionChevron,
  ResourceListSectionSummary,
  ResourceListSectionTitle,
  ResourceListTitle,
  ResourceListViewport,
} from "@egghead/ui/resource-list";

import type { CourseForPage, CourseLesson } from "./course";
import { ScrollToActiveLesson } from "./scroll-to-active-lesson";

const NO_COMPLETED_LESSONS: ReadonlySet<string> = new Set();

export function directCourseLessons(course: CourseForPage) {
  const sectionedLessonIds = new Set(
    course.sections.flatMap((section) => section.lessons.map((lesson) => lesson.id)),
  );

  return course.lessons.filter((lesson) => !sectionedLessonIds.has(lesson.id));
}

export function formatLessonDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);

  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function courseDurationLabel(lessons: CourseLesson[]) {
  const total = lessons.reduce((sum, lesson) => sum + (lesson.duration ?? 0), 0);
  if (!total) return null;

  const minutes = Math.max(1, Math.round(total / 60));
  const hours = Math.floor(minutes / 60);

  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

export function sectionDurationLabel(lessons: CourseLesson[]) {
  const total = lessons.reduce((sum, lesson) => sum + (lesson.duration ?? 0), 0);
  if (!total) return null;

  return `${Math.max(1, Math.round(total / 60))}m`;
}

/* The curriculum card shared by the course page and the lesson rail:
   unsectioned lessons first, then one collapsible section per chapter.
   The variation between pages: which lesson is active, and an optional
   header slot pinned above the scrolling viewport (the lesson rail puts
   the course-title link there). */
export function CourseCurriculum({
  activeLessonSlug,
  className,
  completedLessonIds = NO_COMPLETED_LESSONS,
  course,
  header,
  showProgress = false,
}: {
  activeLessonSlug?: string | undefined;
  className?: string | undefined;
  completedLessonIds?: ReadonlySet<string> | undefined;
  course: CourseForPage;
  header?: ReactNode;
  showProgress?: boolean | undefined;
}) {
  const directLessons = directCourseLessons(course);

  return (
    <ResourceListCard className={className}>
      {header}
      <ResourceListViewport>
        {activeLessonSlug ? <ScrollToActiveLesson activeLessonSlug={activeLessonSlug} /> : null}
        {directLessons.length > 0 ? (
          <CourseLessonList
            activeLessonSlug={activeLessonSlug}
            className="pt-3"
            completedLessonIds={completedLessonIds}
            lessons={directLessons}
          />
        ) : null}
        {course.sections.map((section) => {
          const duration = sectionDurationLabel(section.lessons);
          const completedCount = section.lessons.reduce(
            (count, lesson) => count + Number(completedLessonIds.has(lesson.id)),
            0,
          );

          return (
            <ResourceListSection key={section.id} open>
              <ResourceListSectionSummary>
                <ResourceListSectionTitle>{section.title}</ResourceListSectionTitle>
                <ResourceListBadge
                  aria-label={
                    showProgress
                      ? `${completedCount} of ${section.lessons.length} watched`
                      : `${section.lessons.length} lessons`
                  }
                >
                  {showProgress
                    ? `${completedCount}/${section.lessons.length}`
                    : section.lessons.length}
                </ResourceListBadge>
                {duration ? <ResourceListMeta>{duration}</ResourceListMeta> : null}
                <ResourceListSectionChevron />
              </ResourceListSectionSummary>
              <CourseLessonList
                activeLessonSlug={activeLessonSlug}
                completedLessonIds={completedLessonIds}
                lessons={section.lessons}
              />
            </ResourceListSection>
          );
        })}
      </ResourceListViewport>
    </ResourceListCard>
  );
}

export function CourseLessonList({
  activeLessonSlug,
  className,
  completedLessonIds = NO_COMPLETED_LESSONS,
  lessons,
}: {
  activeLessonSlug?: string | undefined;
  className?: string | undefined;
  completedLessonIds?: ReadonlySet<string> | undefined;
  lessons: CourseLesson[];
}) {
  return (
    <ResourceList className={className}>
      {lessons.map((lesson, index) => {
        const isActive = lesson.slug === activeLessonSlug;
        const isCompleted = completedLessonIds.has(lesson.id);
        const linkStatus = isActive ? "active" : isCompleted ? "completed" : "upcoming";
        const indicatorStatus = isCompleted ? "completed" : isActive ? "active" : "upcoming";

        return (
          <ResourceListItem key={lesson.id}>
            <ResourceListLink
              as={Link}
              data-watched={isCompleted ? "true" : "false"}
              href={lesson.canonicalPath}
              prefetch={true}
              status={linkStatus}
            >
              <ResourceListIndicator index={index} status={indicatorStatus} />
              <ResourceListTitle>
                {lesson.title}
                {isCompleted ? <span className="sr-only"> — Watched</span> : null}
              </ResourceListTitle>
              {lesson.duration ? (
                <ResourceListMeta>{formatLessonDuration(lesson.duration)}</ResourceListMeta>
              ) : null}
            </ResourceListLink>
          </ResourceListItem>
        );
      })}
    </ResourceList>
  );
}
