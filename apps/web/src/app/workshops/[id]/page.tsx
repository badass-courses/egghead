import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { getPublishedWorkshop, getWorkshopOffer } from "../../../workshops/catalog";
import { WorkshopLandingPage } from "../../../workshops/landing-page";
import { getWorkshopPayments } from "../../../workshops/payments";
import { canPurchaseWorkshop } from "../../../workshops/checkout-contract";

async function PublishedWorkshopPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const workshop = await getPublishedWorkshop(id);
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
    <WorkshopLandingPage
      workshop={workshop}
      offer={offer}
      checkoutAvailable={checkoutAvailable}
      preview={false}
    />
  );
}
export default function WorkshopPage(props: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<output>Loading workshop…</output>}>
      <PublishedWorkshopPage {...props} />
    </Suspense>
  );
}
