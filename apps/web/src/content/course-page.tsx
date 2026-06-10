import Link from "next/link";
import { Container } from "@egghead/ui/container";
import { SectionHeader, Stack } from "@egghead/ui/structure";

import type { CourseForPage } from "./course";
import { MarkdownContent } from "./markdown-content";

export async function CoursePageStatic({ course }: { course: CourseForPage }) {
  "use cache";

  const sectionedLessonIds = new Set(
    course.sections.flatMap((section) => section.lessons.map((lesson) => lesson.id)),
  );
  const directLessons = course.lessons.filter((lesson) => !sectionedLessonIds.has(lesson.id));

  return (
    <Container as="main" size="wide">
      <Stack gap="loose">
        <SectionHeader description={course.description} eyebrow="Course" title={course.title} />
        <MarkdownContent label="Course body">{course.body}</MarkdownContent>

        <dl className="egghead-course-facts" aria-label="Course facts">
          <div>
            <dt>Lessons</dt>
            <dd>{course.lessonCount}</dd>
          </div>
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

        <section className="egghead-lesson-section" aria-labelledby="course-lessons">
          <h2 id="course-lessons">Lessons</h2>
          {course.sections.length > 0 ? (
            <div className="egghead-course-outline">
              {directLessons.length > 0 ? (
                <section className="egghead-course-outline-section">
                  <h3>Lessons</h3>
                  <CourseLessonList lessons={directLessons} />
                </section>
              ) : null}
              {course.sections.map((section) => (
                <section className="egghead-course-outline-section" key={section.id}>
                  <h3>{section.title}</h3>
                  <CourseLessonList lessons={section.lessons} />
                </section>
              ))}
            </div>
          ) : (
            <CourseLessonList lessons={course.lessons} />
          )}
        </section>
      </Stack>
    </Container>
  );
}

function CourseLessonList({ lessons }: { lessons: CourseForPage["lessons"] }) {
  return (
    <ol className="egghead-lesson-list">
      {lessons.map((lesson, index) => (
        <li key={lesson.id} className="egghead-lesson-row">
          <Link href={lesson.canonicalPath} prefetch={true}>
            <span className="egghead-lesson-index">{String(index + 1).padStart(2, "0")}</span>
            <span>
              <span className="egghead-lesson-title">{lesson.title}</span>
              {lesson.duration ? (
                <span className="egghead-lesson-duration">
                  {Math.round(lesson.duration / 60)} min
                </span>
              ) : null}
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}
