import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getLessonBySlug, getLessonStaticParams } from "../../../../content/lesson";
import { LessonAccessExperience, LessonEmbedPageStatic } from "../../../../content/lesson-page";
import { legacyLessonEmbedPath } from "../../../../content/routes";

type LessonEmbedPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

async function lessonSlugFromParams(params: LessonEmbedPageProps["params"]) {
  const resolved = await params;
  return decodeURIComponent(resolved.slug);
}

export function generateStaticParams() {
  return getLessonStaticParams();
}

export async function generateMetadata({ params }: LessonEmbedPageProps): Promise<Metadata> {
  const slug = await lessonSlugFromParams(params);
  const lesson = await getLessonBySlug(slug);

  if (!lesson) {
    return {
      title: "Lesson embed not found | egghead",
    };
  }

  return {
    title: `${lesson.title} embed | egghead`,
    robots: {
      index: false,
      follow: true,
    },
    alternates: {
      canonical: `https://egghead.io${legacyLessonEmbedPath(lesson.slug)}`,
    },
  };
}

export default async function LessonEmbedPage({ params }: LessonEmbedPageProps) {
  const slug = await lessonSlugFromParams(params);
  const lesson = await getLessonBySlug(slug);

  if (!lesson) notFound();

  return (
    <LessonEmbedPageStatic
      accessComponent={<LessonAccessExperience lesson={lesson} />}
      lesson={lesson}
    />
  );
}
