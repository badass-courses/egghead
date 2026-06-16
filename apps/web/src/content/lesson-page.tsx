import { headers } from "next/headers";
import Link from "next/link";
import { cache, Suspense, type ReactNode } from "react";
import { Container } from "@egghead/ui/container";
import { SectionHeader, Stack } from "@egghead/ui/structure";

import {
  ResourceListHeader,
  ResourceListHeaderEyebrow,
  ResourceListHeaderMeta,
  ResourceListHeaderTitle,
} from "@egghead/ui/resource-list";

import { getCurrentUserFromRequest } from "../coursebuilder/current-user";
import type { CourseForPage } from "./course";
import { CourseCurriculum, courseDurationLabel } from "./course-lesson-list";
import { lessonRequiresAccess } from "./lesson-access";
import { LessonHtmlVideo } from "./lesson-html-video";
import { LessonMuxPlayer } from "./lesson-mux-player";
import { MuxPlayerProvider } from "./mux-player-context";
import { getLessonVideoTranscript } from "./lesson-transcript";
import { LessonTranscriptBody } from "./lesson-transcript-renderer";
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
          {transcriptState === "retained" ? "Available" : "Needs source"}
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

/* One access resolution per request: the player and the facts render as
   separate dynamic islands (so the page can place them apart), but they
   share this cached lookup instead of fetching the user twice. */
const resolveLessonAccess = cache(async (lesson: LessonForPage) => {
  const accessRequired = lessonRequiresAccess(lesson);
  const currentUser = accessRequired
    ? await getCurrentUserFromRequest(
        new Request("http://egghead.local/lesson", { headers: await headers() }),
        { legacyRailsPlaylistId: lesson.parentCourseLegacyRailsPlaylistId },
      )
    : null;
  const accessGranted = !accessRequired || currentUser?.contentAccess?.granted === true;

  return { accessGranted, accessRequired, currentUser };
});

export async function LessonPlayerExperience({ lesson }: { lesson: LessonForPage }) {
  const { accessGranted, accessRequired } = await resolveLessonAccess(lesson);
  const videoUrl = lesson.videoHlsUrl ?? lesson.videoDashUrl;
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
        <LessonHtmlVideo
          accessState={accessRequired ? "granted" : "free"}
          poster={lesson.videoPosterUrl ?? undefined}
          src={videoUrl}
          title={lesson.title}
        />
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
    </>
  );
}

export async function LessonFactsExperience({ lesson }: { lesson: LessonForPage }) {
  const { accessRequired, currentUser } = await resolveLessonAccess(lesson);

  return (
    <LessonFacts
      accessReason={accessRequired ? (currentUser?.contentAccess?.reason ?? "denied") : "free"}
      accessRequired={accessRequired}
      lesson={lesson}
    />
  );
}

/* The transcript lives on the lesson's associated videoResource
   (fields.transcript), read from the DB in getLessonVideoTranscript.
   Rendered (client) with clickable timestamps that seek the shared Mux
   player, inside a collapsible — ai-hero's accordion equivalent. */
export async function LessonTranscriptSection({ lesson }: { lesson: LessonForPage }) {
  const transcript = await getLessonVideoTranscript(lesson.id);
  if (!transcript) return null;

  return (
    <details className="egghead-transcript" aria-label="Transcript" open>
      <summary className="egghead-transcript-summary">Video Transcript</summary>
      <div className="egghead-prose egghead-markdown">
        <LessonTranscriptBody transcript={transcript} />
      </div>
    </details>
  );
}

export function LessonAccessExperience({ lesson }: { lesson: LessonForPage }) {
  return (
    <>
      <LessonPlayerExperience lesson={lesson} />
      <LessonFactsExperience lesson={lesson} />
    </>
  );
}

/* Lesson rail: sits flush against the player and matches its height
   exactly. The absolutely positioned card takes no part in the grid
   row's height (the player's aspect ratio decides it) and drops its
   left rounding/border so player + curriculum read as one unit. Below
   960px the rail stacks under the player at natural height. */
export function CourseLessonNavigation({
  activeLessonSlug,
  course,
}: {
  activeLessonSlug: string;
  course: CourseForPage;
}) {
  const duration = courseDurationLabel(course.lessons);

  return (
    <aside className="relative min-w-0" aria-label={`${course.title} lessons`}>
      <CourseCurriculum
        activeLessonSlug={activeLessonSlug}
        className="min-[960px]:absolute min-[960px]:inset-0 min-[960px]:rounded-l-none min-[960px]:border-l-0"
        course={course}
        header={
          <ResourceListHeader>
            <ResourceListHeaderEyebrow>Course</ResourceListHeaderEyebrow>
            <ResourceListHeaderTitle
              as={Link}
              className="text-inherit no-underline transition-colors hover:text-rust"
              href={course.canonicalPath}
              prefetch={true}
            >
              {course.title}
            </ResourceListHeaderTitle>
            <ResourceListHeaderMeta>
              {course.lessonCount} {course.lessonCount === 1 ? "lesson" : "lessons"}
              {duration ? ` · ${duration}` : null}
            </ResourceListHeaderMeta>
          </ResourceListHeader>
        }
      />
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
    <MuxPlayerProvider>
      <Stack gap="loose">
        <SectionHeader description={lesson.description} eyebrow={eyebrow} title={lesson.title} />
        <Suspense fallback={<LessonAccessFallback lesson={lesson} />}>{accessComponent}</Suspense>
        <MarkdownContent label="Lesson body">{lesson.body}</MarkdownContent>
        <Suspense>
          <LessonTranscriptSection lesson={lesson} />
        </Suspense>
      </Stack>
    </MuxPlayerProvider>
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
  course,
  factsComponent,
  lesson,
  playerComponent,
}: {
  course: CourseForPage;
  factsComponent: ReactNode;
  lesson: LessonForPage;
  playerComponent: ReactNode;
}) {
  "use cache";

  return (
    <Container as="main" size="wide" className="pt-4">
      <MuxPlayerProvider>
        <Stack gap="loose">
          <div className="grid gap-8 min-[960px]:grid-cols-[minmax(0,1fr)_minmax(260px,340px)] min-[960px]:gap-0">
            <div className="egghead-lesson-player-cell min-w-0">
              <Suspense fallback={<LessonVideoPlaceholder lesson={lesson} />}>
                {playerComponent}
              </Suspense>
            </div>
            <CourseLessonNavigation activeLessonSlug={lesson.slug} course={course} />
          </div>
          <SectionHeader
            description={lesson.description}
            eyebrow="Course lesson"
            title={lesson.title}
          />
          <Suspense
            fallback={
              <LessonFacts
                accessReason="pending"
                accessRequired={lessonRequiresAccess(lesson)}
                lesson={lesson}
              />
            }
          >
            {factsComponent}
          </Suspense>
          <MarkdownContent label="Lesson body">{lesson.body}</MarkdownContent>
          <Suspense>
            <LessonTranscriptSection lesson={lesson} />
          </Suspense>
        </Stack>
      </MuxPlayerProvider>
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
