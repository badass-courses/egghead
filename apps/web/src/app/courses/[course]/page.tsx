import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Container } from "@egghead/ui/container";
import { SectionHeader, Stack } from "@egghead/ui/structure";

import { getCourseBySlug, getCourseStaticParams } from "../../../content/course";

type CoursePageProps = {
  params: Promise<{
    course: string;
  }>;
};

async function courseSlugFromParams(params: CoursePageProps["params"]) {
  const resolved = await params;
  return decodeURIComponent(resolved.course);
}

export async function generateMetadata({ params }: CoursePageProps): Promise<Metadata> {
  const slug = await courseSlugFromParams(params);
  const course = await getCourseBySlug(slug);

  if (!course) {
    return {
      title: "Course not found | egghead",
    };
  }

  return {
    title: `${course.title} | egghead`,
    description: course.description,
    alternates: {
      canonical: `https://egghead.io/courses/${course.slug}`,
    },
    openGraph: {
      title: course.title,
      description: course.description,
      url: `https://egghead.io/courses/${course.slug}`,
      type: "article",
    },
  };
}

export function generateStaticParams() {
  return getCourseStaticParams();
}

export default async function CoursePage({ params }: CoursePageProps) {
  const slug = await courseSlugFromParams(params);
  const course = await getCourseBySlug(slug);

  if (!course) notFound();

  return (
    <Container as="main" size="wide">
      <Stack gap="loose">
        <SectionHeader description={course.description} eyebrow="Course" title={course.title} />

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
          <ol className="egghead-lesson-list">
            {course.lessons.map((lesson, index) => (
              <li key={lesson.id} className="egghead-lesson-row">
                <a href={`/lessons/${lesson.slug}`}>
                  <span className="egghead-lesson-index">{String(index + 1).padStart(2, "0")}</span>
                  <span>
                    <span className="egghead-lesson-title">{lesson.title}</span>
                    {lesson.duration ? (
                      <span className="egghead-lesson-duration">
                        {Math.round(lesson.duration / 60)} min
                      </span>
                    ) : null}
                  </span>
                </a>
              </li>
            ))}
          </ol>
        </section>
      </Stack>
    </Container>
  );
}
