import { getCourseBySlug } from "../content/course";
import type { LessonForPage } from "../content/lesson";
import { syncCourseProgressForUser, type CourseProgressSyncState } from "./course-progress";
import { withProgressTransaction } from "./progress-transaction";
import {
  completeResourceForUser,
  uncompleteResourceForUser,
  type ResourceProgressState,
} from "./resource-progress";

export type ProgressCourse = { courseId: string; lessonIds: string[] };
export type ProgressCourseReference = { id: string; slug: string };

// Resolve authoritative curricula before opening a write transaction. A missing
// course must not silently turn a course lesson into a standalone completion.
export async function resolveLessonProgressCourses(
  lesson: LessonForPage,
  requestedCourse?: ProgressCourseReference,
): Promise<ProgressCourse[]> {
  const references: ProgressCourseReference[] = [];
  if (requestedCourse) references.push(requestedCourse);
  if (
    lesson.parentCourseId &&
    lesson.parentCourseSlug &&
    !references.some((course) => course.id === lesson.parentCourseId)
  ) {
    references.push({ id: lesson.parentCourseId, slug: lesson.parentCourseSlug });
  }
  if (lesson.courseLinked && references.length === 0) {
    throw new Error("Lesson course progress is unavailable");
  }
  return Promise.all(
    references.map(async (reference) => {
      const course = await getCourseBySlug(reference.slug);
      if (
        !course ||
        course.id !== reference.id ||
        !course.lessons.some((item) => item.id === lesson.id)
      ) {
        throw new Error("Lesson course progress is unavailable");
      }
      return { courseId: course.id, lessonIds: course.lessons.map((item) => item.id) };
    }),
  );
}

export async function writeLessonProgressForUser(input: {
  userId: string;
  resourceId: string;
  source: string;
  completed: boolean;
  courses: readonly ProgressCourse[];
}): Promise<{ state: ResourceProgressState; course: CourseProgressSyncState | null }> {
  return withProgressTransaction(input.userId, async (connection) => {
    const progress = input.completed
      ? await completeResourceForUser(input, connection)
      : await uncompleteResourceForUser(input, connection);
    if (progress.state.completed !== input.completed) {
      throw new Error("Lesson progress could not be reconciled");
    }
    const course = await input.courses.reduce<Promise<CourseProgressSyncState | null>>(
      async (previous, curriculum) => {
        const firstCourse = await previous;
        const synced = await syncCourseProgressForUser(
          { userId: input.userId, ...curriculum },
          connection,
        );
        return firstCourse ?? synced;
      },
      Promise.resolve(null),
    );
    return { state: progress.state, course };
  });
}
