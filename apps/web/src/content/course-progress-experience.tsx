import { SectionHeader } from "@egghead/ui/structure";

import { LessonProgressProvider } from "../progress/lesson-progress-provider";
import type { CourseForPage } from "./course";
import {
  CourseLessonProgressNavigation,
  CoursePageProgressCurriculum,
} from "./course-progress-curriculum";
import { getLessonProgressSnapshot } from "./lesson-progress-read";
import { LessonProgressControl, LessonProgressFeedback } from "./lesson-progress-status";
import { LessonPlayerExperience } from "./lesson-page";
import type { LessonForPage } from "./lesson";

export async function CourseProgressCurriculumExperience({ course }: { course: CourseForPage }) {
  const progress = await getLessonProgressSnapshot(course.lessons.map((lesson) => lesson.id));
  const progressKey = `${course.id}:${progress.isAuthenticated}:${progress.initialCompletedLessonIds.join("|")}`;

  return (
    <LessonProgressProvider key={progressKey} {...progress}>
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
  const progressKey = `${course.id}:${progress.isAuthenticated}:${progress.initialCompletedLessonIds.join("|")}`;

  return (
    <LessonProgressProvider key={progressKey} {...progress}>
      <div className="grid gap-8 min-[960px]:grid-cols-[minmax(0,1fr)_minmax(260px,340px)] min-[960px]:gap-x-0 min-[960px]:gap-y-flow">
        <div className="egghead-lesson-player-cell min-w-0">
          <LessonPlayerExperience lesson={lesson} />
        </div>
        <CourseLessonProgressNavigation activeLessonSlug={lesson.slug} course={course} />
        <div className="order-2 min-[960px]:order-3 min-[960px]:col-span-2">
          <SectionHeader
            description={lesson.description}
            eyebrow="Course lesson"
            title={lesson.title}
            titleAccessory={<LessonProgressFeedback lessonResourceId={lesson.id} />}
            titleLeading={<LessonProgressControl lessonResourceId={lesson.id} />}
          />
        </div>
      </div>
    </LessonProgressProvider>
  );
}
