import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { getWorkshopBySlug } from "../../../workshops/read";
import { WorkshopPage } from "../../../content/workshop-page";

type WorkshopRouteProps = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({ params }: WorkshopRouteProps): Promise<Metadata> {
  const { slug } = await params;
  const workshop = await getWorkshopBySlug(decodeURIComponent(slug));
  if (!workshop) return {};

  return {
    robots: { index: workshop.visibility === "public", follow: true },
    description: workshop.description,
    title: `${workshop.title} | egghead workshop`,
    alternates: { canonical: `/workshops/${workshop.slug}` },
    openGraph: {
      description: workshop.description,
      title: workshop.title,
      type: "website",
      url: `/workshops/${workshop.slug}`,
      ...(workshop.imageUrl ? { images: [{ url: workshop.imageUrl }] } : {}),
    },
  };
}

async function WorkshopRouteContent({ params }: WorkshopRouteProps) {
  const { slug } = await params;
  const workshop = await getWorkshopBySlug(decodeURIComponent(slug));
  if (!workshop) notFound();

  return <WorkshopPage workshop={workshop} />;
}

export default function WorkshopRoute(props: WorkshopRouteProps) {
  return (
    <Suspense fallback={null}>
      <WorkshopRouteContent {...props} />
    </Suspense>
  );
}
