import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";

import { WorkshopLandingPage } from "../../../../workshops/landing-page";

import { getLocalWorkshop, localWorkshopConnection } from "../../../../workshops/local-preview";

export const metadata: Metadata = {
  title: "Workshop draft | egghead",
  robots: { index: false, follow: false },
};

async function WorkshopDraft({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  if (!localWorkshopConnection()) notFound();
  const { id } = await params;
  const workshop = await getLocalWorkshop(id);
  if (!workshop) notFound();
  return <WorkshopLandingPage workshop={workshop} />;
}

export default function WorkshopDraftPage(props: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<output>Loading workshop…</output>}>
      <WorkshopDraft {...props} />
    </Suspense>
  );
}
