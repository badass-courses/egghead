import type { Metadata } from "next";

import { getPublicContentStaticParams } from "../../../content/public-resource";
import { getPublicContentMetadata, renderPublicContentRoute } from "../../../content/public-route";

type TipPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

async function slugFromParams(params: TipPageProps["params"]) {
  const resolved = await params;
  return decodeURIComponent(resolved.slug);
}

export function generateStaticParams() {
  return getPublicContentStaticParams(["tip"]);
}

export async function generateMetadata({ params }: TipPageProps): Promise<Metadata> {
  const slug = await slugFromParams(params);
  return getPublicContentMetadata({
    canonicalPrefix: "/tips",
    families: ["tip"],
    label: "Tip",
    slug,
  });
}

export default async function TipPage({ params }: TipPageProps) {
  const slug = await slugFromParams(params);
  return renderPublicContentRoute({ eyebrow: "Tip", families: ["tip"], slug });
}
