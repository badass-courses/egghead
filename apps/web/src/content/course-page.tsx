import Image from "next/image";
import { Suspense, type ReactNode } from "react";
import { Container } from "@egghead/ui/container";
import { ResourceListLabel } from "@egghead/ui/resource-list";
import { SectionHeader, Stack } from "@egghead/ui/structure";

import { safePublicAvatarUrl } from "../profile/contracts";
import type { CourseForPage } from "./course";
import { CourseCurriculum } from "./course-lesson-list";
import { MarkdownContent } from "./markdown-content";

function instructorInitials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const firstInitial = words[0]?.slice(0, 1) ?? "";
  const lastInitial = words.length > 1 ? (words.at(-1)?.slice(0, 1) ?? "") : "";

  return `${firstInitial}${lastInitial}`.toUpperCase();
}

function CourseInstructor({
  instructorImage,
  instructorName,
}: {
  instructorImage: string | null;
  instructorName: string | null;
}) {
  if (!instructorName) return null;
  const safeInstructorImage = safePublicAvatarUrl(instructorImage);

  return (
    <div
      aria-label={`Instructor: ${instructorName}`}
      className="inline-flex min-w-0 max-w-full items-center gap-2 text-sm font-extrabold text-foreground"
    >
      <span
        aria-hidden="true"
        className="relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-full border border-border-strong bg-surface text-xs font-black tracking-tight"
      >
        {instructorInitials(instructorName)}
        {safeInstructorImage ? (
          <Image alt="" className="object-cover" fill sizes="32px" src={safeInstructorImage} />
        ) : null}
      </span>
      <span className="truncate">{instructorName}</span>
    </div>
  );
}

export async function CoursePageStatic({
  course,
  curriculumComponent,
}: {
  course: CourseForPage;
  curriculumComponent: ReactNode;
}) {
  "use cache";

  return (
    <Container as="main" size="wide">
      <div className="egghead-collection-lesson-layout">
        <div className="egghead-collection-lesson-main">
          <Stack gap="loose">
            <div className="grid gap-3" data-course-access={course.access}>
              <SectionHeader
                description={course.description}
                eyebrow={`Course / ${course.access === "free" ? "Free" : "Pro"}`}
                title={course.title}
              />
              <CourseInstructor
                instructorImage={course.instructorImage}
                instructorName={course.instructorName}
              />
            </div>
            <MarkdownContent label="Course body">{course.body}</MarkdownContent>
          </Stack>
        </div>

        <aside className="egghead-course-aside min-[960px]:sticky-rail" aria-label="Course details">
          <section className="flex min-h-0 flex-col gap-3" aria-labelledby="course-lessons">
            <ResourceListLabel as="h2" className="shrink-0" id="course-lessons">
              {course.lessonCount} {course.lessonCount === 1 ? "lesson" : "lessons"}
            </ResourceListLabel>
            <Suspense fallback={<CourseCurriculum course={course} />}>
              {curriculumComponent}
            </Suspense>
          </section>
        </aside>
      </div>
    </Container>
  );
}
