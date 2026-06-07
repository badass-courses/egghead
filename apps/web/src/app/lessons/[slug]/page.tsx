import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Container } from "@egghead/ui/container";
import { SectionHeader, Stack } from "@egghead/ui/structure";

import { getLessonBySlug } from "../../../content/lesson";

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

  return (
    <Container as="main" size="narrow">
      <Stack gap="loose">
        <SectionHeader description={lesson.description} eyebrow="Lesson" title={lesson.title} />

        {videoUrl ? (
          <video
            aria-label={`${lesson.title} video`}
            className="egghead-video"
            controls
            preload="metadata"
            src={videoUrl}
          >
            <track kind="captions" />
          </video>
        ) : (
          <div className="egghead-video-placeholder" data-video-state="unavailable" />
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
            <dd>{lesson.freeForever ? "Free" : lesson.isProContent ? "Pro" : "Included"}</dd>
          </div>
        </dl>
      </Stack>
    </Container>
  );
}
