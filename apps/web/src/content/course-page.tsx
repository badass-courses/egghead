import { Container } from "@egghead/ui/container";
import { ResourceListLabel } from "@egghead/ui/resource-list";
import { SectionHeader, Stack } from "@egghead/ui/structure";

import type { CourseForPage } from "./course";
import { CourseCurriculum } from "./course-lesson-list";
import { MarkdownContent } from "./markdown-content";

export async function CoursePageStatic({ course }: { course: CourseForPage }) {
  "use cache";

  return (
    <Container as="main" size="wide">
      <div className="egghead-collection-lesson-layout">
        <div className="egghead-collection-lesson-main">
          <Stack gap="loose">
            <SectionHeader description={course.description} eyebrow="Course" title={course.title} />
            <MarkdownContent label="Course body">{course.body}</MarkdownContent>
          </Stack>
        </div>

        <aside className="egghead-course-aside min-[960px]:sticky-rail" aria-label="Course details">
          {course.instructorName || course.accessState ? (
            <dl className="egghead-course-facts" aria-label="Course facts">
              {course.instructorName ? (
                <div>
                  <dt>Instructor</dt>
                  <dd>{course.instructorName}</dd>
                </div>
              ) : null}
              {course.accessState ? (
                <div>
                  <dt>Access</dt>
                  <dd>{course.accessState}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}

          <section className="flex min-h-0 flex-col gap-3" aria-labelledby="course-lessons">
            <ResourceListLabel as="h2" className="shrink-0" id="course-lessons">
              {course.lessonCount} {course.lessonCount === 1 ? "lesson" : "lessons"}
            </ResourceListLabel>
            <CourseCurriculum course={course} />
          </section>
        </aside>
      </div>
    </Container>
  );
}
