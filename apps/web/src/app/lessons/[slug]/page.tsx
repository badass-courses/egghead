import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";

import { getLessonBySlug, getLessonStaticParams } from "../../../content/lesson";

type LessonPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

async function lessonSlugFromParams(params: LessonPageProps["params"]) {
  const resolved = await params;
  return decodeURIComponent(resolved.slug);
}

export function generateStaticParams() {
  return getLessonStaticParams();
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
      canonical: `https://egghead.io${lesson.canonicalPath}`,
    },
  };
}

export default async function LessonLegacyRedirectPage({ params }: LessonPageProps) {
  const slug = await lessonSlugFromParams(params);
  const lesson = await getLessonBySlug(slug);

  if (!lesson) notFound();

  permanentRedirect(lesson.canonicalPath);
}
