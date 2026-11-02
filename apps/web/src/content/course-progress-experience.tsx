import { SectionHeader } from "@egghead/ui/structure";

import { LessonProgressProvider } from "../progress/lesson-progress-provider";
import type { CourseForPage } from "./course";
import {
  CourseLessonProgressNavigation,
  CoursePageProgressCurriculum,
} from "./course-progress-curriculum";
import { getLessonProgressSnapshot } from "./lesson-progress-read";
import { LessonProgressControl, LessonProgressFeedback } from "./lesson-progress-status";
import { CourseLessonLayout, LessonPlayerExperience } from "./lesson-page";
import type { LessonForPage } from "./lesson";

export async function CourseProgressCurriculumExperience({ course }: { course: CourseForPage }) {
  const progress = await getLessonProgressSnapshot(course.lessons.map((lesson) => lesson.id));

  return (
    <LessonProgressProvider {...progress}>
      <CoursePageProgressCurriculum course={course} />
    </LessonProgressProvider>
  );
}

export async function CourseLessonProgressExperience({
  course,
  lesson,
}: {
  course: CourseForPage;
  lesson: LessonForPage;
}) {
  const progress = await getLessonProgressSnapshot(course.lessons.map((item) => item.id));

  return (
    <LessonProgressProvider
      course={{
        id: course.id,
        slug: course.slug,
        title: course.title,
        lessonCount: course.lessons.length,
      }}
      {...progress}
    >
      <CourseLessonLayout
        header={
          <SectionHeader
            description={lesson.description}
            eyebrow="Course lesson"
            title={lesson.title}
            titleAccessory={<LessonProgressFeedback lessonResourceId={lesson.id} />}
            titleLeading={<LessonProgressControl lessonResourceId={lesson.id} />}
          />
        }
        navigation={
          <CourseLessonProgressNavigation activeLessonSlug={lesson.slug} course={course} />
        }
        player={<LessonPlayerExperience lesson={lesson} />}
      />
    </LessonProgressProvider>
  );
}
