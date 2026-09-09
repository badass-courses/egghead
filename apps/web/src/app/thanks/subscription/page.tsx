import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { Container } from "@egghead/ui/container";
import { getCurrentUser } from "../../../coursebuilder/current-user";
import { getMembershipServices } from "../../../subscriptions/catalog";

export const metadata = { title: "Thanks for subscribing | egghead" };
const panel =
  "mx-auto grid w-full max-w-[38rem] gap-6 rounded-[1.75rem] border border-border-strong bg-surface-grad p-6 text-center shadow-card-deep sm:p-9";
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function money(amount: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount / 100);
}

async function SubscriptionThanks({ searchParams }: Props) {
  await connection();
  const query = await searchParams;
  const sessionId = typeof query["session_id"] === "string" ? query["session_id"] : "";
  const user = await getCurrentUser();
  if (!user?.id) {
    const callbackUrl = `/thanks/subscription?session_id=${encodeURIComponent(sessionId)}`;
    redirect(`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }
  const services = getMembershipServices();
  const session =
    services && /^cs_(test_|live_)?[A-Za-z0-9]+$/.test(sessionId)
      ? await services.payments.stripe.checkout.sessions
          .retrieve(sessionId, { expand: ["invoice"] })
          .catch(() => null)
      : null;
  const ownedSession =
    session &&
    services &&
    session.client_reference_id === user.id &&
    session.metadata?.["userId"] === user.id &&
    session.metadata["productId"] === services.configuration.productId &&
    session.livemode === services.configuration.live &&
    session.mode === "subscription"
      ? session
      : null;
  const product =
    ownedSession && services
      ? await services.adapter.getProduct(services.configuration.productId, false)
      : null;
  const complete = ownedSession?.status === "complete";
  const paid =
    complete &&
    (ownedSession.payment_status === "paid" ||
      ownedSession.payment_status === "no_payment_required");
  const title = paid
    ? "Thanks for subscribing."
    : complete
      ? "Your payment is processing."
      : "We couldn’t confirm your checkout.";
  const invoice =
    ownedSession && typeof ownedSession.invoice === "object" ? ownedSession.invoice : null;
  const description = paid
    ? "Your payment is confirmed. Thank you for joining egghead."
    : complete
      ? "Stripe is still confirming your payment. Your membership is not active yet."
      : "Return to pricing to try again, or refresh this page if you just completed checkout.";
  return (
    <section aria-labelledby="subscription-thanks-heading" className={panel}>
      <div>
        <h1
          id="subscription-thanks-heading"
          className="text-balance text-4xl font-black tracking-tight"
        >
          {title}
        </h1>
        <p className="mt-3 text-pretty font-semibold text-muted-foreground">{description}</p>
      </div>
      {invoice ? (
        <section
          aria-labelledby="invoice-heading"
          className="grid gap-5 rounded-2xl border border-border bg-well p-5 text-left shadow-well"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 id="invoice-heading" className="text-lg font-black">
                Invoice {invoice.number}
              </h2>
              <p className="mt-1 text-sm font-semibold text-muted-foreground">
                {new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(
                  new Date(invoice.created * 1000),
                )}
              </p>
            </div>
            <span className="rounded-full bg-sage-wash px-3 py-1 text-sm font-extrabold text-sage-foreground">
              {invoice.status === "paid" ? "Paid" : "Payment pending"}
            </span>
          </div>
          {invoice.customer_email ? (
            <p className="break-all text-sm font-semibold text-muted-foreground">
              Billed to {invoice.customer_email}
            </p>
          ) : null}
          <ul className="grid gap-3 border-y border-border py-4">
            {invoice.lines.data.map((line) => (
              <li key={line.id} className="flex justify-between gap-4 text-sm font-semibold">
                <span>
                  {line.quantity ?? 1} × {product?.name ?? "Egghead membership"}
                </span>
                <span className="shrink-0 tabular-nums">
                  {money(line.amount, invoice.currency)}
                </span>
              </li>
            ))}
          </ul>
          <dl className="grid gap-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt>Total</dt>
              <dd className="font-bold tabular-nums">{money(invoice.total, invoice.currency)}</dd>
            </div>
            <div className="flex justify-between gap-4 text-base font-extrabold">
              <dt>Amount paid</dt>
              <dd className="tabular-nums">{money(invoice.amount_paid, invoice.currency)}</dd>
            </div>
          </dl>
          <div className="flex flex-wrap gap-5 text-sm font-extrabold">
            {invoice.hosted_invoice_url ? (
              <a
                href={invoice.hosted_invoice_url}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-4"
              >
                View invoice
              </a>
            ) : null}
            {invoice.invoice_pdf ? (
              <a
                href={invoice.invoice_pdf}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-4"
              >
                Download invoice PDF
              </a>
            ) : null}
          </div>
        </section>
      ) : complete ? (
        <p className="text-sm font-semibold text-muted-foreground">
          Your invoice is being prepared.{" "}
          <a
            className="underline underline-offset-4"
            href={`/thanks/subscription?session_id=${encodeURIComponent(sessionId)}`}
          >
            Refresh invoice
          </a>
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Link
          href="/profile"
          className="press inline-flex items-center justify-center rounded-xl border border-border-strong bg-surface-grad px-6 py-3 font-extrabold text-foreground shadow-btn-ghost"
        >
          Your account
        </Link>
        <Link
          href={complete ? "/courses" : "/pricing"}
          className="press inline-flex items-center justify-center rounded-xl border border-yolk-shadow/40 bg-yolk-grad px-7 pt-[15px] pb-[13px] font-extrabold text-yolk-foreground shadow-btn hover:shadow-btn-hover"
        >
          {complete ? "Browse courses" : "Back to pricing"}
        </Link>
      </div>
    </section>
  );
}

export default function SubscriptionThanksPage(props: Props) {
  return (
    <Container
      as="main"
      className="content-center gap-y-0 py-[clamp(2.5rem,8vh,6rem)]"
      size="narrow"
    >
      <Suspense
        fallback={
          <section aria-busy="true" className={panel}>
            <p className="font-bold text-muted-foreground">Checking your membership…</p>
          </section>
        }
      >
        <SubscriptionThanks {...props} />
      </Suspense>
    </Container>
  );
}
