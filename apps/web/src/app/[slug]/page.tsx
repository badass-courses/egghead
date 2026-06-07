import type { Metadata } from "next";

import { getPublicContentStaticParams } from "../../content/public-resource";
import { getPublicContentMetadata, renderPublicContentRoute } from "../../content/public-route";

type ArticlePageProps = {
  params: Promise<{
    slug: string;
  }>;
};

async function slugFromParams(params: ArticlePageProps["params"]) {
  const resolved = await params;
  return decodeURIComponent(resolved.slug);
}

export function generateStaticParams() {
  return getPublicContentStaticParams(["article"]);
}

export async function generateMetadata({ params }: ArticlePageProps): Promise<Metadata> {
  const slug = await slugFromParams(params);
  return getPublicContentMetadata({
    canonicalPrefix: "",
    families: ["article"],
    label: "Article",
    slug,
  });
}

export default async function ArticlePage({ params }: ArticlePageProps) {
  const slug = await slugFromParams(params);
  return renderPublicContentRoute({ eyebrow: "Article", families: ["article"], slug });
}
