import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getWorkshopPayments } from "../../../../workshops/payments";

export const metadata = {
  title: "Workshop purchase | egghead",
  robots: { index: false, follow: false },
};
async function WorkshopThanks({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ session_id?: string }>;
}) {
  await connection();
  const { id } = await params;
  const { session_id: sessionId } = await searchParams;
  const services = getWorkshopPayments();
  if (!services || !sessionId || !/^cs_(test_|live_)?[A-Za-z0-9]+$/.test(sessionId)) notFound();
  const session = await services.payments.stripe.checkout.sessions.retrieve(sessionId);
  if (
    session.mode !== "payment" ||
    session.metadata?.["workshopId"] !== id ||
    session.livemode !== services.live
  )
    notFound();
  const paid = session.payment_status === "paid" && session.status === "complete";
  return (
    <main className="mx-auto max-w-prose px-6 py-20">
      <h1 className="text-4xl font-bold">
        {paid ? "Thanks for joining the workshop." : "Your payment is processing."}
      </h1>
      <p className="my-6">
        {paid
          ? "Payment received. Your workshop purchase is being recorded."
          : "Your purchase will be confirmed after payment succeeds."}
      </p>
      <Link className="underline" href={`/workshop/${encodeURIComponent(id)}`}>
        Back to the workshop
      </Link>
    </main>
  );
}
export default function ThanksPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ session_id?: string }>;
}) {
  return (
    <Suspense fallback={<output>Checking payment…</output>}>
      <WorkshopThanks {...props} />
    </Suspense>
  );
}
