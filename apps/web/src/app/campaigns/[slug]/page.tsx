import type { Metadata } from "next";

import { getPublicContentStaticParams } from "../../../content/public-resource";
import { getPublicContentMetadata, renderPublicContentRoute } from "../../../content/public-route";

type CampaignPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

async function slugFromParams(params: CampaignPageProps["params"]) {
  const resolved = await params;
  return decodeURIComponent(resolved.slug);
}

export function generateStaticParams() {
  return getPublicContentStaticParams(["campaign"]);
}

export async function generateMetadata({ params }: CampaignPageProps): Promise<Metadata> {
  const slug = await slugFromParams(params);
  return getPublicContentMetadata({
    canonicalPrefix: "/campaigns",
    families: ["campaign"],
    label: "Campaign",
    slug,
  });
}

export default async function CampaignPage({ params }: CampaignPageProps) {
  const slug = await slugFromParams(params);
  return renderPublicContentRoute({ eyebrow: "Campaign", families: ["campaign"], slug });
}
