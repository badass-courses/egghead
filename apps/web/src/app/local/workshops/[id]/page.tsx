import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";

import { WorkshopLandingPage } from "../../../../workshops/landing-page";
import { getWorkshopOffer } from "../../../../workshops/catalog";
import { getWorkshopPayments } from "../../../../workshops/payments";
import { canPurchaseWorkshop } from "../../../../workshops/checkout-contract";

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
  const offer = await getWorkshopOffer(workshop);
  const checkoutAvailable =
    Boolean(getWorkshopPayments()) &&
    canPurchaseWorkshop({
      state: workshop.fields.state,
      hasOffer: Boolean(offer),
      startsAt: workshop.fields.startsAt,
    });
  return (
    <WorkshopLandingPage workshop={workshop} offer={offer} checkoutAvailable={checkoutAvailable} />
  );
}

export default function WorkshopDraftPage(props: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<output>Loading workshop…</output>}>
      <WorkshopDraft {...props} />
    </Suspense>
  );
}
