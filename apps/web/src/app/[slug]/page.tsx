import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";

import { getCourseBySlug, getCourseStaticParams } from "../../content/course";
import { CoursePageStatic } from "../../content/course-page";
import { getLessonBySlug, getStandaloneLessonStaticParams } from "../../content/lesson";
import { LessonAccessExperience, StandaloneLessonPageStatic } from "../../content/lesson-page";
import { getPodcastShowBySlug, getPodcastShowStaticParams } from "../../content/podcast";
import { PodcastShowPageStatic } from "../../content/podcast-page";
import {
  getPublicContentBySlug,
  getPublicContentStaticParams,
  type PublicContentFamily,
} from "../../content/public-resource";
import { renderPublicContentRoute } from "../../content/public-route";
import { STANDALONE_PUBLIC_CONTENT_FAMILIES } from "../../content/routes";

type RootContentPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

function uniqueStaticParams(params: Array<{ slug: string }>) {
  const seen = new Set<string>();
  const result: Array<{ slug: string }> = [];

  for (const param of params) {
    if (seen.has(param.slug)) continue;
    seen.add(param.slug);
    result.push(param);
  }

  return result;
}

async function slugFromParams(params: RootContentPageProps["params"]) {
  const resolved = await params;
  return decodeURIComponent(resolved.slug);
}

export async function generateStaticParams() {
  const [courses, podcastShows, standaloneLessons, publicResources] = await Promise.all([
    getCourseStaticParams(),
    getPodcastShowStaticParams(),
    getStandaloneLessonStaticParams(),
    getPublicContentStaticParams([...STANDALONE_PUBLIC_CONTENT_FAMILIES]),
  ]);

  return uniqueStaticParams([
    ...courses,
    ...podcastShows,
    ...standaloneLessons,
    ...publicResources,
  ]);
}

export async function generateMetadata({ params }: RootContentPageProps): Promise<Metadata> {
  const slug = await slugFromParams(params);
  const course = await getCourseBySlug(slug);

  if (course) {
    return {
      title: `${course.title} | egghead`,
      description: course.description,
      alternates: {
        canonical: `https://egghead.io${course.canonicalPath}`,
      },
      openGraph: {
        title: course.title,
        description: course.description,
        url: `https://egghead.io${course.canonicalPath}`,
        type: "article",
      },
    };
  }

  const podcastShow = await getPodcastShowBySlug(slug);

  if (podcastShow) {
    return {
      title: `${podcastShow.title} | egghead`,
      description: podcastShow.description,
      alternates: {
        canonical: `https://egghead.io${podcastShow.canonicalPath}`,
      },
      openGraph: {
        title: podcastShow.title,
        description: podcastShow.description,
        url: `https://egghead.io${podcastShow.canonicalPath}`,
        type: "article",
      },
    };
  }

  const publicResource = await getPublicContentBySlug(slug, [
    ...STANDALONE_PUBLIC_CONTENT_FAMILIES,
  ] satisfies PublicContentFamily[]);

  if (publicResource) {
    return {
      title: `${publicResource.title} | egghead`,
      description: publicResource.description,
      alternates: {
        canonical: `https://egghead.io${publicResource.canonicalPath}`,
      },
      openGraph: {
        title: publicResource.title,
        description: publicResource.description,
        url: `https://egghead.io${publicResource.canonicalPath}`,
        type: "article",
      },
    };
  }

  const lesson = await getLessonBySlug(slug);

  if (lesson) {
    return {
      title: `${lesson.title} | egghead`,
      description: lesson.description,
      alternates: {
        canonical: `https://egghead.io${lesson.canonicalPath}`,
      },
      openGraph: {
        title: lesson.title,
        description: lesson.description,
        url: `https://egghead.io${lesson.canonicalPath}`,
        type: "article",
      },
    };
  }

  return {
    title: "Content not found | egghead",
  };
}

export default async function RootContentPage({ params }: RootContentPageProps) {
  const slug = await slugFromParams(params);
  const course = await getCourseBySlug(slug);

  if (course) return <CoursePageStatic course={course} />;

  const podcastShow = await getPodcastShowBySlug(slug);

  if (podcastShow) return <PodcastShowPageStatic show={podcastShow} />;

  const publicResource = await getPublicContentBySlug(slug, [
    ...STANDALONE_PUBLIC_CONTENT_FAMILIES,
  ] satisfies PublicContentFamily[]);

  if (publicResource) {
    if (publicResource.canonicalPath !== `/${slug}`) {
      permanentRedirect(publicResource.canonicalPath);
    }

    return renderPublicContentRoute({
      eyebrow: publicResource.family,
      families: [publicResource.family],
      slug,
    });
  }

  const lesson = await getLessonBySlug(slug);

  if (lesson?.courseLinked) {
    permanentRedirect(lesson.canonicalPath);
  }

  if (lesson) {
    return (
      <StandaloneLessonPageStatic
        accessComponent={<LessonAccessExperience lesson={lesson} />}
        lesson={lesson}
      />
    );
  }

  return notFound();
}
