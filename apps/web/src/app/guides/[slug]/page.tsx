import type { Metadata } from "next";

import { getPublicContentStaticParams } from "../../../content/public-resource";
import { getPublicContentMetadata, renderPublicContentRoute } from "../../../content/public-route";

type GuidePageProps = {
  params: Promise<{
    slug: string;
  }>;
};

async function slugFromParams(params: GuidePageProps["params"]) {
  const resolved = await params;
  return decodeURIComponent(resolved.slug);
}

export function generateStaticParams() {
  return getPublicContentStaticParams(["guide"]);
}

export async function generateMetadata({ params }: GuidePageProps): Promise<Metadata> {
  const slug = await slugFromParams(params);
  return getPublicContentMetadata({
    canonicalPrefix: "/guides",
    families: ["guide"],
    label: "Guide",
    slug,
  });
}

export default async function GuidePage({ params }: GuidePageProps) {
  const slug = await slugFromParams(params);
  return renderPublicContentRoute({ eyebrow: "Guide", families: ["guide"], slug });
}
