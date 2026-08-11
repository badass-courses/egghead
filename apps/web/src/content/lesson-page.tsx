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

import { getCurrentUser, getCurrentUserFromRequest } from "../coursebuilder/current-user";
import {
  ANONYMOUS_LESSON_LIMIT,
  anonymousLessonAccess,
} from "../progress/anonymous-lesson-progress";
import { LessonProgressProvider } from "../progress/lesson-progress-provider";
import type { CourseForPage } from "./course";
import { CourseCurriculum, courseDurationLabel } from "./course-lesson-list";
import { lessonRequiresAccess } from "./lesson-access";
import { LessonHtmlVideo } from "./lesson-html-video";
import { LessonMuxPlayer } from "./lesson-mux-player";
import { getLessonProgressSnapshot } from "./lesson-progress-read";
import { LessonProgressStatus } from "./lesson-progress-status";
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

  if (accessRequired) {
    const currentUser = await getCurrentUserFromRequest(
      new Request("http://egghead.local/lesson", { headers: await headers() }),
      { legacyRailsPlaylistId: lesson.parentCourseLegacyRailsPlaylistId },
    );
    const accessGranted = currentUser.contentAccess?.granted === true;

    return {
      accessGranted,
      accessReason: currentUser.contentAccess?.reason ?? "denied",
      accessRequired,
      anonymousLimitReached: false,
    };
  }

  const sessionUser = await getCurrentUser();
  const anonymousAccess = sessionUser?.id ? null : await anonymousLessonAccess(lesson.id);
  const accessGranted = Boolean(sessionUser?.id) || anonymousAccess?.canWatch !== false;

  return {
    accessGranted,
    accessReason: anonymousAccess?.canWatch === false ? "anonymous_lesson_limit" : "free",
    accessRequired,
    anonymousLimitReached: anonymousAccess?.canWatch === false,
  };
});

export async function LessonPlayerExperience({ lesson }: { lesson: LessonForPage }) {
  const { accessGranted, accessRequired, anonymousLimitReached } =
    await resolveLessonAccess(lesson);
  const videoUrl = lesson.videoHlsUrl ?? lesson.videoDashUrl;
  const playbackId = lesson.videoMuxPlaybackId;
  const hasVideo = Boolean(playbackId || videoUrl);
  const canWatch = hasVideo && accessGranted;
  const videoState = canWatch ? "allowed" : hasVideo ? "gated" : "unavailable";

  return (
    <>
      {canWatch && playbackId ? (
        <LessonMuxPlayer
          lessonResourceId={lesson.id}
          playbackId={playbackId}
          poster={lesson.videoPosterUrl}
          title={lesson.title}
          videoId={lesson.videoResourceId ?? lesson.id}
        />
      ) : canWatch && videoUrl ? (
        <LessonHtmlVideo
          accessState={accessRequired ? "granted" : "free"}
          lessonResourceId={lesson.id}
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
              <p className="egghead-eyebrow">
                {anonymousLimitReached ? "Keep your progress" : "Access required"}
              </p>
              <p>
                {anonymousLimitReached
                  ? `You've watched ${ANONYMOUS_LESSON_LIMIT} lessons. Sign in to keep learning and save them to your account.`
                  : "This lesson is available with an active egghead membership."}
              </p>
              <Link
                data-access-cta={
                  anonymousLimitReached ? "anonymous-limit-login" : "login-or-subscribe"
                }
                href={`/login?${new URLSearchParams({ callbackUrl: lesson.canonicalPath }).toString()}`}
              >
                {anonymousLimitReached ? "Sign in to keep learning" : "Sign in or subscribe"}
              </Link>
            </div>
          ) : null}
        </LessonVideoPlaceholder>
      )}
    </>
  );
}

export async function LessonFactsExperience({ lesson }: { lesson: LessonForPage }) {
  const { accessReason, accessRequired } = await resolveLessonAccess(lesson);

  return (
    <LessonFacts accessReason={accessReason} accessRequired={accessRequired} lesson={lesson} />
  );
}

/* Renders the transcript with clickable timestamps that seek the shared
   Mux player, inside a collapsible. */
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

export async function LessonAccessExperience({
  lesson,
  showProgressStatus = false,
}: {
  lesson: LessonForPage;
  showProgressStatus?: boolean;
}) {
  const progress = await getLessonProgressSnapshot([lesson.id]);
  const progressKey = `${lesson.id}:${progress.isAuthenticated}:${progress.initialCompletedLessonIds.join("|")}`;

  return (
    <LessonProgressProvider key={progressKey} {...progress}>
      <LessonPlayerExperience lesson={lesson} />
      {showProgressStatus ? <LessonProgressStatus lessonResourceId={lesson.id} /> : null}
      <LessonFactsExperience lesson={lesson} />
    </LessonProgressProvider>
  );
}

export function CourseLessonLayout({
  header,
  navigation,
  player,
}: {
  header: ReactNode;
  navigation: ReactNode;
  player: ReactNode;
}) {
  return (
    <div className="grid gap-8 min-[960px]:grid-cols-[minmax(0,1fr)_minmax(260px,340px)] min-[960px]:gap-x-0 min-[960px]:gap-y-flow">
      <div className="egghead-lesson-player-cell min-w-0">{player}</div>
      {navigation}
      <div className="order-2 min-[960px]:order-3 min-[960px]:col-span-2">{header}</div>
    </div>
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
    <aside
      className="relative order-3 min-w-0 min-[960px]:order-2"
      aria-label={`${course.title} lessons`}
    >
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
  learningComponent,
  lesson,
}: {
  course: CourseForPage;
  factsComponent: ReactNode;
  learningComponent: ReactNode;
  lesson: LessonForPage;
}) {
  "use cache";

  return (
    <Container as="main" size="wide" className="pt-4">
      <MuxPlayerProvider>
        <Stack gap="loose">
          <Suspense
            fallback={
              <CourseLessonLayout
                header={
                  <SectionHeader
                    description={lesson.description}
                    eyebrow="Course lesson"
                    title={lesson.title}
                  />
                }
                navigation={
                  <CourseLessonNavigation activeLessonSlug={lesson.slug} course={course} />
                }
                player={<LessonVideoPlaceholder lesson={lesson} />}
              />
            }
          >
            {learningComponent}
          </Suspense>
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
