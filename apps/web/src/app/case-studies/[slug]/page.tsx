import type { Metadata } from "next";

import { getPublicContentStaticParams } from "../../../content/public-resource";
import { getPublicContentMetadata, renderPublicContentRoute } from "../../../content/public-route";

type CaseStudyPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

async function slugFromParams(params: CaseStudyPageProps["params"]) {
  const resolved = await params;
  return decodeURIComponent(resolved.slug);
}

export function generateStaticParams() {
  return getPublicContentStaticParams(["case-study"]);
}

export async function generateMetadata({ params }: CaseStudyPageProps): Promise<Metadata> {
  const slug = await slugFromParams(params);
  return getPublicContentMetadata({
    canonicalPrefix: "/case-studies",
    families: ["case-study"],
    label: "Case study",
    slug,
  });
}

export default async function CaseStudyPage({ params }: CaseStudyPageProps) {
  const slug = await slugFromParams(params);
  return renderPublicContentRoute({ eyebrow: "Case study", families: ["case-study"], slug });
}
