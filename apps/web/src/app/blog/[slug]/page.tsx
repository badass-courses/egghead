import { notFound, permanentRedirect } from "next/navigation";

import { getPublicContentStaticParams } from "../../../content/public-resource";
import { articleCanonicalPathForLegacySlug } from "../../../routing/article-alias";
import { slugParamOrNotFound } from "../../../routing/slug-param";

type BlogPostRedirectPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

export function generateStaticParams() {
  return getPublicContentStaticParams(["article"]);
}

// /blog/<slug> goes straight to the article's canonical URL, including a
// unique "~suffix" match for legacy unsuffixed slugs. A slug with no article
// is a real 404, never a redirect into a dead end.
export default async function BlogPostRedirectPage({ params }: BlogPostRedirectPageProps) {
  const { slug } = await params;
  const canonicalPath = await articleCanonicalPathForLegacySlug(slugParamOrNotFound(slug));
  if (!canonicalPath) notFound();

  permanentRedirect(canonicalPath);
}
