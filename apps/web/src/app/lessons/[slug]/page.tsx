import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Container } from "@egghead/ui/container";
import { SectionHeader, Stack } from "@egghead/ui/structure";

import { getLessonBySlug } from "../../../content/lesson";
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

export default async function LessonPage({ params }: LessonPageProps) {
  const slug = await lessonSlugFromParams(params);
  const lesson = await getLessonBySlug(slug);

  if (!lesson) notFound();

  const videoUrl = lesson.videoHlsUrl ?? lesson.videoDashUrl;
  const requestHeaders = await headers();
  const currentUser = await getCurrentUserFromRequest(
    new Request("http://egghead.local/lesson", { headers: requestHeaders }),
  );
  const accessRequired = !lesson.freeForever;
  const accessGranted = !accessRequired || currentUser.user?.access.granted === true;
  const canWatch = Boolean(videoUrl && accessGranted);
  const videoState = canWatch ? "allowed" : videoUrl && accessRequired ? "gated" : "unavailable";
  const transcriptState = lesson.hasTranscript || lesson.hasSrt ? "retained" : "needs_source";

  return (
    <Container as="main" size="narrow">
      <Stack gap="loose">
        <SectionHeader description={lesson.description} eyebrow="Lesson" title={lesson.title} />

        {canWatch && videoUrl ? (
          <video
            aria-label={`${lesson.title} video`}
            className="egghead-video"
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
            className="egghead-video-placeholder"
            data-access-state={accessGranted ? "granted" : "denied"}
            data-video-state={videoState}
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
          </div>
        )}

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
              data-access-reason={
                accessRequired ? (currentUser.user?.access.reason ?? "denied") : "free"
              }
            >
              {lesson.freeForever ? "Free" : lesson.isProContent ? "Pro" : "Included"}
            </dd>
          </div>
          <div>
            <dt>Transcript</dt>
            <dd data-transcript-state={transcriptState}>
              {transcriptState === "retained" ? "Retained from source evidence" : "Needs source"}
            </dd>
          </div>
        </dl>
      </Stack>
    </Container>
  );
}
