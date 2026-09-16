import type { Metadata } from "next";

import { getPublicContentStaticParams } from "../../../content/public-resource";
import { getPublicContentMetadata, renderPublicContentRoute } from "../../../content/public-route";
import { EMPTY_STATIC_PARAM, withStaticParamFallback } from "../../../content/static-params";

type TalkPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

async function slugFromParams(params: TalkPageProps["params"]) {
  const resolved = await params;
  return decodeURIComponent(resolved.slug);
}

export async function generateStaticParams() {
  return withStaticParamFallback(await getPublicContentStaticParams(["talk"]), {
    slug: EMPTY_STATIC_PARAM,
  });
}

export async function generateMetadata({ params }: TalkPageProps): Promise<Metadata> {
  const slug = await slugFromParams(params);
  return getPublicContentMetadata({
    canonicalPrefix: "/talks",
    families: ["talk"],
    label: "Talk",
    slug,
  });
}

export default async function TalkPage({ params }: TalkPageProps) {
  const slug = await slugFromParams(params);
  return renderPublicContentRoute({ eyebrow: "Talk", families: ["talk"], slug });
}
