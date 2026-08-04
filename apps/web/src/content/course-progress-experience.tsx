import { LessonProgressProvider } from "../progress/lesson-progress-provider";
import type { CourseForPage } from "./course";
import {
  CourseLessonProgressNavigation,
  CoursePageProgressCurriculum,
} from "./course-progress-curriculum";
import { getLessonProgressSnapshot } from "./lesson-progress-read";
import { LessonProgressStatus } from "./lesson-progress-status";
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
      <div>
        <div className="grid gap-8 min-[960px]:grid-cols-[minmax(0,1fr)_minmax(260px,340px)] min-[960px]:gap-0">
          <div className="egghead-lesson-player-cell min-w-0">
            <LessonPlayerExperience lesson={lesson} />
          </div>
          <CourseLessonProgressNavigation activeLessonSlug={lesson.slug} course={course} />
        </div>
        <LessonProgressStatus lessonResourceId={lesson.id} />
      </div>
    </LessonProgressProvider>
  );
}
