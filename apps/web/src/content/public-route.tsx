import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PublicContentPage } from "./public-resource-page";
import {
  getPublicContentBySlug,
  pathForPublicContentFamily,
  type PublicContentFamily,
} from "./public-resource";

export async function getPublicContentMetadata({
  canonicalPrefix,
  families,
  label,
  slug,
}: {
  canonicalPrefix: string;
  families: PublicContentFamily[];
  label: string;
  slug: string;
}): Promise<Metadata> {
  const resource = await getPublicContentBySlug(slug, families);
  const title = resource?.title ?? "Public resource not found";
  const canonicalPath = resource
    ? pathForPublicContentFamily(resource.family, resource.slug)
    : `${canonicalPrefix}/${slug}`;

  return {
    title: `${title} | egghead`,
    description: resource?.description ?? `Browse egghead ${label.toLowerCase()} content.`,
    alternates: {
      canonical: `https://egghead.io${canonicalPath}`,
    },
    openGraph: resource
      ? {
          title: resource.title,
          description: resource.description,
          url: `https://egghead.io${canonicalPath}`,
          type: "article",
        }
      : undefined,
  };
}

export async function renderPublicContentRoute({
  eyebrow,
  families,
  slug,
}: {
  eyebrow: string;
  families: PublicContentFamily[];
  slug: string;
}) {
  const resource = await getPublicContentBySlug(slug, families);

  if (!resource) notFound();

  return <PublicContentPage eyebrow={eyebrow} resource={resource} />;
}
