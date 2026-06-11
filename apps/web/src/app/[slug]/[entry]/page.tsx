import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  getCourseBySlug,
  getCourseLesson,
  getCourseLessonStaticParams,
} from "../../../content/course";
import { getLessonById, type LessonForPage } from "../../../content/lesson";
import { CourseLessonPageStatic, LessonAccessExperience } from "../../../content/lesson-page";
import {
  getPodcastEpisode,
  getPodcastEpisodeStaticParams,
  getPodcastShowBySlug,
} from "../../../content/podcast";
import { PodcastEpisodePageStatic } from "../../../content/podcast-page";

type CollectionEntryPageProps = {
  params: Promise<{
    slug: string;
    entry: string;
  }>;
};

async function routeParams(params: CollectionEntryPageProps["params"]) {
  const resolved = await params;

  return {
    collection: decodeURIComponent(resolved.slug),
    entry: decodeURIComponent(resolved.entry),
  };
}

function lessonInRouteContext(input: {
  course: NonNullable<Awaited<ReturnType<typeof getCourseBySlug>>>;
  lesson: LessonForPage;
  canonicalPath: string;
}): LessonForPage {
  return {
    ...input.lesson,
    courseLinked: true,
    parentCourseId: input.course.id,
    parentCourseSlug: input.course.slug,
    parentCourseTitle: input.course.title,
    parentCourseLegacyRailsPlaylistId: input.course.legacyRailsPlaylistId,
    canonicalPath: input.canonicalPath,
  };
}

export function generateStaticParams() {
  return Promise.all([getCourseLessonStaticParams(), getPodcastEpisodeStaticParams()]).then(
    ([courseLessons, podcastEpisodes]) =>
      [...courseLessons, ...podcastEpisodes].map((param) => ({
        entry: param.entry,
        slug: param.collection,
      })),
  );
}

export async function generateMetadata({ params }: CollectionEntryPageProps): Promise<Metadata> {
  const { collection, entry } = await routeParams(params);
  const course = await getCourseBySlug(collection);
  const courseLesson = course ? getCourseLesson(course, entry) : null;

  if (course && courseLesson) {
    const lesson = await getLessonById(courseLesson.id);

    return {
      title: `${lesson?.title ?? courseLesson.title} | ${course.title} | egghead`,
      description: lesson?.description ?? courseLesson.description,
      alternates: {
        canonical: `https://egghead.io${courseLesson.canonicalPath}`,
      },
      openGraph: {
        title: lesson?.title ?? courseLesson.title,
        description: lesson?.description ?? courseLesson.description,
        url: `https://egghead.io${courseLesson.canonicalPath}`,
        type: "article",
      },
    };
  }

  const podcastShow = await getPodcastShowBySlug(collection);
  const podcastEpisode = podcastShow ? getPodcastEpisode(podcastShow, entry) : null;

  if (podcastShow && podcastEpisode) {
    return {
      title: `${podcastEpisode.title} | ${podcastShow.title} | egghead`,
      description: podcastEpisode.description,
      alternates: {
        canonical: `https://egghead.io${podcastEpisode.canonicalPath}`,
      },
      openGraph: {
        title: podcastEpisode.title,
        description: podcastEpisode.description,
        url: `https://egghead.io${podcastEpisode.canonicalPath}`,
        type: "article",
      },
    };
  }

  return {
    title: "Content not found | egghead",
  };
}

export default async function CollectionEntryPage({ params }: CollectionEntryPageProps) {
  const { collection, entry } = await routeParams(params);
  const course = await getCourseBySlug(collection);
  const courseLesson = course ? getCourseLesson(course, entry) : null;

  if (course && courseLesson) {
    const lesson = await getLessonById(courseLesson.id);

    if (!lesson) notFound();

    const contextualLesson = lessonInRouteContext({
      canonicalPath: courseLesson.canonicalPath,
      course,
      lesson,
    });

    return (
      <CourseLessonPageStatic
        accessComponent={<LessonAccessExperience lesson={contextualLesson} />}
        course={course}
        lesson={contextualLesson}
      />
    );
  }

  const podcastShow = await getPodcastShowBySlug(collection);
  const podcastEpisode = podcastShow ? getPodcastEpisode(podcastShow, entry) : null;

  if (podcastShow && podcastEpisode) {
    return <PodcastEpisodePageStatic episode={podcastEpisode} show={podcastShow} />;
  }

  return notFound();
}
