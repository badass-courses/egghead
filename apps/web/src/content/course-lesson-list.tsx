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
  course,
  header,
}: {
  activeLessonSlug?: string | undefined;
  className?: string | undefined;
  course: CourseForPage;
  header?: ReactNode;
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
            lessons={directLessons}
          />
        ) : null}
        {course.sections.map((section) => {
          const duration = sectionDurationLabel(section.lessons);

          return (
            <ResourceListSection key={section.id} open>
              <ResourceListSectionSummary>
                <ResourceListSectionTitle>{section.title}</ResourceListSectionTitle>
                <ResourceListBadge>{section.lessons.length}</ResourceListBadge>
                {duration ? <ResourceListMeta>{duration}</ResourceListMeta> : null}
                <ResourceListSectionChevron />
              </ResourceListSectionSummary>
              <CourseLessonList activeLessonSlug={activeLessonSlug} lessons={section.lessons} />
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
  lessons,
}: {
  activeLessonSlug?: string | undefined;
  className?: string | undefined;
  lessons: CourseLesson[];
}) {
  return (
    <ResourceList className={className}>
      {lessons.map((lesson, index) => {
        const status = lesson.slug === activeLessonSlug ? "active" : "upcoming";

        return (
          <ResourceListItem key={lesson.id}>
            <ResourceListLink as={Link} href={lesson.canonicalPath} prefetch={true} status={status}>
              <ResourceListIndicator index={index} status={status} />
              <ResourceListTitle>{lesson.title}</ResourceListTitle>
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
