import { permanentRedirect } from "next/navigation";

import { getPublicContentStaticParams } from "../../../content/public-resource";

type BlogPostRedirectPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

const BLOG_REDIRECT_TARGETS: Record<string, string> = {
  "manage-reactive-state-with-solid-js-signals": "manage-reactive-state-with-solidjs-signals",
};

export function generateStaticParams() {
  return getPublicContentStaticParams(["article"]);
}

export default async function BlogPostRedirectPage({ params }: BlogPostRedirectPageProps) {
  const { slug } = await params;
  const decodedSlug = decodeURIComponent(slug);
  const targetSlug = BLOG_REDIRECT_TARGETS[decodedSlug] ?? decodedSlug;

  permanentRedirect(`/${targetSlug}`);
}
