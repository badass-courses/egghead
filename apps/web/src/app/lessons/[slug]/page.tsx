import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { Container } from "@egghead/ui/container";
import { SectionHeader } from "@egghead/ui/structure";

import {
  getLessonBySlug,
  getLessonStaticParams,
  type LessonForPage,
} from "../../../content/lesson";
import { LessonMuxPlayer } from "../../../content/lesson-mux-player";
import { MarkdownContent } from "../../../content/markdown-content";
import { getCurrentUserFromRequest } from "../../../coursebuilder/current-user";

type LessonPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

async function lessonSlugFromParams(params: LessonPageProps["params"]) {
  const resolved = await params;
  return decodeURIComponent(resolved.slug);
}

export async function generateMetadata({ params }: LessonPageProps): Promise<Metadata> {
  const slug = await lessonSlugFromParams(params);
  const lesson = await getLessonBySlug(slug);

  if (!lesson) {
    return {
      title: "Lesson not found | egghead",
    };
  }

  return {
    title: `${lesson.title} | egghead`,
    description: lesson.description,
    alternates: {
      canonical: `https://egghead.io/lessons/${lesson.slug}`,
    },
    openGraph: {
      title: lesson.title,
      description: lesson.description,
      url: `https://egghead.io/lessons/${lesson.slug}`,
      type: "article",
    },
  };
}

export function generateStaticParams() {
  return getLessonStaticParams();
}

function LessonAccessFallback({ lesson }: { lesson: LessonForPage }) {
  return (
    <>
      <div
        className="egghead-video-placeholder breakout"
        data-access-state="pending"
        data-video-state="pending"
      />

      <LessonFacts accessReason="pending" accessRequired={lesson.courseLinked} lesson={lesson} />
    </>
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

async function LessonAccessExperience({ lesson }: { lesson: LessonForPage }) {
  const videoUrl = lesson.videoHlsUrl ?? lesson.videoDashUrl;
  const requestHeaders = await headers();
  const currentUser = await getCurrentUserFromRequest(
    new Request("http://egghead.local/lesson", { headers: requestHeaders }),
    { legacyRailsPlaylistId: lesson.parentCourseLegacyRailsPlaylistId },
  );
  const accessRequired = lesson.courseLinked && !lesson.freeForever;
  const accessGranted = !accessRequired || currentUser.contentAccess?.granted === true;
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
          title={lesson.title}
          videoId={lesson.videoResourceId ?? lesson.id}
        />
      ) : canWatch && videoUrl ? (
        <video
          aria-label={`${lesson.title} video`}
          className="egghead-video breakout"
          controls
          data-access-state={accessRequired ? "granted" : "free"}
          data-video-state="allowed"
          preload="metadata"
          src={videoUrl}
        >
          <track kind="captions" />
        </video>
      ) : (
        <div
          className="egghead-video-placeholder breakout"
          data-access-state={accessGranted ? "granted" : "denied"}
          data-video-state={videoState}
        >
          {videoState === "gated" ? (
            <div className="egghead-video-placeholder-content">
              <p className="eyebrow">Access required</p>
              <p>This lesson is available with an active egghead membership.</p>
              <Link data-access-cta="login-or-subscribe" href="/login">
                Sign in or subscribe
              </Link>
            </div>
          ) : null}
        </div>
      )}

      <LessonFacts
        accessReason={accessRequired ? (currentUser.contentAccess?.reason ?? "denied") : "free"}
        accessRequired={accessRequired}
        lesson={lesson}
      />
    </>
  );
}

async function LessonPageStatic({
  accessComponent,
  lesson,
}: {
  accessComponent: ReactNode;
  lesson: LessonForPage;
}) {
  "use cache";

  return (
    <Container as="main" size="narrow">
      <SectionHeader description={lesson.description} eyebrow="Lesson" title={lesson.title} />

      <Suspense fallback={<LessonAccessFallback lesson={lesson} />}>{accessComponent}</Suspense>
      <MarkdownContent label="Lesson body">{lesson.body}</MarkdownContent>
    </Container>
  );
}

export default async function LessonPage({ params }: LessonPageProps) {
  const slug = await lessonSlugFromParams(params);
  const lesson = await getLessonBySlug(slug);

  if (!lesson) notFound();

  return (
    <LessonPageStatic
      accessComponent={<LessonAccessExperience lesson={lesson} />}
      lesson={lesson}
    />
  );
}
