import { headers } from "next/headers";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { Container } from "@egghead/ui/container";
import { SectionHeader, Stack } from "@egghead/ui/structure";

import { getCurrentUserFromRequest } from "../coursebuilder/current-user";
import type { CourseForPage, CourseLesson } from "./course";
import { lessonRequiresAccess } from "./lesson-access";
import { LessonMuxPlayer } from "./lesson-mux-player";
import type { LessonForPage } from "./lesson";
import { MarkdownContent } from "./markdown-content";

function LessonVideoPlaceholder({
  accessState = "pending",
  children,
  lesson,
  videoState = "pending",
}: {
  accessState?: string;
  children?: ReactNode;
  lesson: LessonForPage;
  videoState?: string;
}) {
  return (
    <div
      className="egghead-video-placeholder"
      data-access-state={accessState}
      data-video-poster={lesson.videoPosterUrl ? "static" : "none"}
      data-video-state={videoState}
      style={
        lesson.videoPosterUrl ? { backgroundImage: `url(${lesson.videoPosterUrl})` } : undefined
      }
    >
      {children}
    </div>
  );
}

function LessonFacts({
  accessReason,
  accessRequired,
  lesson,
}: {
  accessReason: string;
  accessRequired: boolean;
  lesson: LessonForPage;
}) {
  const transcriptState = lesson.hasTranscript || lesson.hasSrt ? "retained" : "needs_source";

  return (
    <dl className="egghead-course-facts" aria-label="Lesson facts">
      {lesson.duration ? (
        <div>
          <dt>Duration</dt>
          <dd>{Math.round(lesson.duration / 60)} min</dd>
        </div>
      ) : null}
      <div>
        <dt>Access</dt>
        <dd
          data-access-reason={accessReason}
          data-course-linked={lesson.courseLinked ? "true" : "false"}
        >
          {!accessRequired ? "Free" : lesson.isProContent ? "Pro" : "Included"}
        </dd>
      </div>
      <div>
        <dt>Transcript</dt>
        <dd data-transcript-state={transcriptState}>
          {transcriptState === "retained" ? "Retained from source evidence" : "Needs source"}
        </dd>
      </div>
    </dl>
  );
}

function LessonAccessFallback({ lesson }: { lesson: LessonForPage }) {
  return (
    <>
      <LessonVideoPlaceholder lesson={lesson} />

      <LessonFacts
        accessReason="pending"
        accessRequired={lessonRequiresAccess(lesson)}
        lesson={lesson}
      />
    </>
  );
}

export async function LessonAccessExperience({ lesson }: { lesson: LessonForPage }) {
  const accessRequired = lessonRequiresAccess(lesson);
  const videoUrl = lesson.videoHlsUrl ?? lesson.videoDashUrl;
  const currentUser = accessRequired
    ? await getCurrentUserFromRequest(
        new Request("http://egghead.local/lesson", { headers: await headers() }),
        { legacyRailsPlaylistId: lesson.parentCourseLegacyRailsPlaylistId },
      )
    : null;
  const accessGranted = !accessRequired || currentUser?.contentAccess?.granted === true;
  const playbackId = lesson.videoMuxPlaybackId;
  const canWatch = Boolean((playbackId || videoUrl) && accessGranted);
  const videoState = canWatch
    ? "allowed"
    : playbackId || (videoUrl && accessRequired)
      ? "gated"
      : "unavailable";

  return (
    <>
      {canWatch && playbackId ? (
        <LessonMuxPlayer
          playbackId={playbackId}
          poster={lesson.videoPosterUrl}
          title={lesson.title}
          videoId={lesson.videoResourceId ?? lesson.id}
        />
      ) : canWatch && videoUrl ? (
        <video
          aria-label={`${lesson.title} video`}
          className="egghead-video"
          controls
          data-access-state={accessRequired ? "granted" : "free"}
          data-video-state="allowed"
          poster={lesson.videoPosterUrl ?? undefined}
          preload="metadata"
          src={videoUrl}
        >
          <track kind="captions" />
        </video>
      ) : (
        <LessonVideoPlaceholder
          accessState={accessGranted ? "granted" : "denied"}
          lesson={lesson}
          videoState={videoState}
        >
          {videoState === "gated" ? (
            <div className="egghead-video-placeholder-content">
              <p className="egghead-eyebrow">Access required</p>
              <p>This lesson is available with an active egghead membership.</p>
              <Link data-access-cta="login-or-subscribe" href="/login">
                Sign in or subscribe
              </Link>
            </div>
          ) : null}
        </LessonVideoPlaceholder>
      )}

      <LessonFacts
        accessReason={accessRequired ? (currentUser?.contentAccess?.reason ?? "denied") : "free"}
        accessRequired={accessRequired}
        lesson={lesson}
      />
    </>
  );
}

function CourseLessonLink({
  activeLessonSlug,
  lesson,
}: {
  activeLessonSlug: string;
  lesson: CourseLesson;
}) {
  const active = lesson.slug === activeLessonSlug;

  return (
    <li className="egghead-collection-nav-item">
      <Link
        aria-current={active ? "page" : undefined}
        className={active ? "egghead-collection-nav-link-active" : undefined}
        data-active-lesson={active ? "true" : "false"}
        href={lesson.canonicalPath}
      >
        <span>{lesson.title}</span>
        {lesson.duration ? <small>{Math.round(lesson.duration / 60)} min</small> : null}
      </Link>
    </li>
  );
}

export function CourseLessonNavigation({
  activeLessonSlug,
  course,
}: {
  activeLessonSlug: string;
  course: CourseForPage;
}) {
  const sectionedLessonIds = new Set(
    course.sections.flatMap((section) => section.lessons.map((lesson) => lesson.id)),
  );
  const directLessons = course.lessons.filter((lesson) => !sectionedLessonIds.has(lesson.id));

  return (
    <aside className="egghead-collection-nav" aria-label={`${course.title} lessons`}>
      <Link className="egghead-collection-nav-title" href={course.canonicalPath}>
        {course.title}
      </Link>
      {directLessons.length > 0 ? (
        <ol className="egghead-collection-nav-list">
          {directLessons.map((lesson) => (
            <CourseLessonLink activeLessonSlug={activeLessonSlug} key={lesson.id} lesson={lesson} />
          ))}
        </ol>
      ) : null}
      {course.sections.map((section) => (
        <section className="egghead-collection-nav-section" key={section.id}>
          <h2>{section.title}</h2>
          <ol className="egghead-collection-nav-list">
            {section.lessons.map((lesson) => (
              <CourseLessonLink
                activeLessonSlug={activeLessonSlug}
                key={lesson.id}
                lesson={lesson}
              />
            ))}
          </ol>
        </section>
      ))}
    </aside>
  );
}

function LessonMain({
  accessComponent,
  eyebrow,
  lesson,
}: {
  accessComponent: ReactNode;
  eyebrow: string;
  lesson: LessonForPage;
}) {
  return (
    <Stack gap="loose">
      <SectionHeader description={lesson.description} eyebrow={eyebrow} title={lesson.title} />
      <Suspense fallback={<LessonAccessFallback lesson={lesson} />}>{accessComponent}</Suspense>
      <MarkdownContent label="Lesson body">{lesson.body}</MarkdownContent>
    </Stack>
  );
}

export async function StandaloneLessonPageStatic({
  accessComponent,
  lesson,
}: {
  accessComponent: ReactNode;
  lesson: LessonForPage;
}) {
  "use cache";

  return (
    <Container as="main" size="narrow">
      <LessonMain accessComponent={accessComponent} eyebrow="Lesson" lesson={lesson} />
    </Container>
  );
}

export async function CourseLessonPageStatic({
  accessComponent,
  course,
  lesson,
}: {
  accessComponent: ReactNode;
  course: CourseForPage;
  lesson: LessonForPage;
}) {
  "use cache";

  return (
    <Container as="main" size="wide">
      <div className="egghead-collection-lesson-layout">
        <div className="egghead-collection-lesson-main">
          <LessonMain accessComponent={accessComponent} eyebrow="Course lesson" lesson={lesson} />
        </div>
        <CourseLessonNavigation activeLessonSlug={lesson.slug} course={course} />
      </div>
    </Container>
  );
}

export async function LessonEmbedPageStatic({
  accessComponent,
  lesson,
}: {
  accessComponent: ReactNode;
  lesson: LessonForPage;
}) {
  "use cache";

  return (
    <main className="egghead-embed">
      <Suspense fallback={<LessonAccessFallback lesson={lesson} />}>{accessComponent}</Suspense>
    </main>
  );
}
