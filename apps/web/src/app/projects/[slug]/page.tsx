import type { Metadata } from "next";

import { getPublicContentStaticParams } from "../../../content/public-resource";
import { getPublicContentMetadata, renderPublicContentRoute } from "../../../content/public-route";

type ProjectPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

async function slugFromParams(params: ProjectPageProps["params"]) {
  const resolved = await params;
  return decodeURIComponent(resolved.slug);
}

export function generateStaticParams() {
  return getPublicContentStaticParams(["project"]);
}

export async function generateMetadata({ params }: ProjectPageProps): Promise<Metadata> {
  const slug = await slugFromParams(params);
  return getPublicContentMetadata({
    canonicalPrefix: "/projects",
    families: ["project"],
    label: "Project",
    slug,
  });
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const slug = await slugFromParams(params);
  return renderPublicContentRoute({ eyebrow: "Project", families: ["project"], slug });
}
