import type { Metadata } from "next";

import { getPublicContentStaticParams } from "../../../content/public-resource";
import { getPublicContentMetadata, renderPublicContentRoute } from "../../../content/public-route";
import { EMPTY_STATIC_PARAM, withStaticParamFallback } from "../../../content/static-params";

type SuccessStoryPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

async function slugFromParams(params: SuccessStoryPageProps["params"]) {
  const resolved = await params;
  return decodeURIComponent(resolved.slug);
}

export async function generateStaticParams() {
  return withStaticParamFallback(await getPublicContentStaticParams(["success-story"]), {
    slug: EMPTY_STATIC_PARAM,
  });
}

export async function generateMetadata({ params }: SuccessStoryPageProps): Promise<Metadata> {
  const slug = await slugFromParams(params);
  return getPublicContentMetadata({
    canonicalPrefix: "/success-stories",
    families: ["success-story"],
    label: "Success story",
    slug,
  });
}

export default async function SuccessStoryPage({ params }: SuccessStoryPageProps) {
  const slug = await slugFromParams(params);
  return renderPublicContentRoute({ eyebrow: "Success story", families: ["success-story"], slug });
}
