import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";

import { getCourseBySlug, getCourseStaticParams } from "../../../content/course";

type CoursePageProps = {
  params: Promise<{
    course: string;
  }>;
};

async function courseSlugFromParams(params: CoursePageProps["params"]) {
  const resolved = await params;
  return decodeURIComponent(resolved.course);
}

export function generateStaticParams() {
  return getCourseStaticParams().then((params) =>
    params.map((param) => ({
      course: param.slug,
    })),
  );
}

export async function generateMetadata({ params }: CoursePageProps): Promise<Metadata> {
  const slug = await courseSlugFromParams(params);
  const course = await getCourseBySlug(slug);

  if (!course) {
    return {
      title: "Course not found | egghead",
    };
  }

  return {
    title: `${course.title} | egghead`,
    description: course.description,
    alternates: {
      canonical: `https://egghead.io${course.canonicalPath}`,
    },
  };
}

export default async function CourseLegacyRedirectPage({ params }: CoursePageProps) {
  const slug = await courseSlugFromParams(params);
  const course = await getCourseBySlug(slug);

  if (!course) notFound();

  permanentRedirect(course.canonicalPath);
}
