import { randomUUID } from "node:crypto";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { Container } from "@egghead/ui/container";
import { isPriceAvailable } from "@coursebuilder/commerce/select-product-price";
import { getCurrentUserWithAccess } from "../../coursebuilder/current-user";
import { getMembershipCatalog } from "../../subscriptions/catalog";
import { SubscriptionOptions, type SubscriptionOption } from "./subscription-options";

export const metadata = { title: "Membership pricing | egghead" };
const subscriptionPanelClassName = "mx-auto grid w-full max-w-[44rem] gap-7";

type PricingProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

async function ResolvedPricingState({ searchParams }: PricingProps) {
  await connection();
  const [{ product }, user, query] = await Promise.all([
    getMembershipCatalog(),
    getCurrentUserWithAccess(),
    searchParams,
  ]);
  if (typeof query["session_id"] === "string")
    redirect(`/thanks/subscription?session_id=${encodeURIComponent(query["session_id"])}`);
  const options: SubscriptionOption[] = (product?.prices ?? [])
    .filter(isPriceAvailable)
    .toSorted((a, b) => (a.fields.offer?.position ?? 0) - (b.fields.offer?.position ?? 0))
    .flatMap((price) => {
      const recurring = price.fields.stripe?.recurring;
      if (!recurring || !product) return [];
      const currency = price.fields.stripe?.currency ?? "usd";
      const label =
        price.fields.offer?.label ??
        (recurring.intervalCount === 1
          ? `Every ${recurring.interval}`
          : `Every ${recurring.intervalCount} ${recurring.interval}s`);
      return [
        {
          productId: product.id,
          priceId: price.id,
          name: product.name,
          description: product.fields.description ?? null,
          currency,
          price: new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
            price.unitAmount,
          ),
          unitAmount: price.unitAmount,
          billingInterval: recurring.interval,
          intervalCount: recurring.intervalCount,
          label,
        },
      ];
    });
  const notice =
    query["error"] === "missing-email"
      ? "Your account needs a valid email address before checkout."
      : query["cancelled"]
        ? "Checkout cancelled. Choose a billing option to try again."
        : query["session_id"]
          ? "Checkout returned from Stripe. Membership activation is handled separately."
          : null;

  return (
    <section className={subscriptionPanelClassName}>
      <header className="grid gap-3 text-center">
        <h1 className="text-balance text-4xl font-black tracking-tight">
          Learn without the paywalls.
        </h1>
        <p className="text-pretty text-lg font-semibold text-muted-foreground">
          Choose your billing schedule for access to every egghead course and lesson. Checkout is
          securely hosted by Stripe.
        </p>
      </header>
      {notice ? (
        <output className="text-center text-sm font-semibold text-muted-foreground">
          {notice}
        </output>
      ) : null}
      {user?.hasProSubscription ? (
        <div className="grid gap-3 rounded-2xl bg-sage-wash p-5 text-center shadow-well">
          <p className="font-extrabold text-sage-foreground">Your membership is active.</p>
          <Link
            className="press inline-flex items-center justify-center rounded-xl border border-border-strong bg-surface-grad px-7 pt-[15px] pb-[13px] font-extrabold shadow-btn-ghost"
            href="/courses"
          >
            Browse courses
          </Link>
        </div>
      ) : options.length > 0 ? (
        <div aria-label="Subscription options" className="mx-auto w-full max-w-[32rem]">
          <SubscriptionOptions
            checkoutAvailable
            configured
            options={options}
            defaultPriceId={product?.price?.id}
            requestId={randomUUID()}
            signedIn={Boolean(user)}
          />
          <p className="mt-4 text-center text-xs font-semibold text-muted-foreground">
            Secure checkout powered by Stripe.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 rounded-2xl bg-well p-6 text-center shadow-well">
          <h2 className="text-xl font-black">Membership options are unavailable.</h2>
          <p className="font-semibold text-muted-foreground">
            No active recurring membership prices are configured. Please try again later.
          </p>
        </div>
      )}
    </section>
  );
}

export default function PricingPage(props: PricingProps) {
  return (
    <Container
      as="main"
      className="content-center gap-y-0 py-[clamp(2.5rem,8vh,6rem)]"
      size="narrow"
    >
      <Suspense
        fallback={
          <section aria-busy="true" className={subscriptionPanelClassName}>
            <p className="text-center font-bold text-muted-foreground">Checking your membership…</p>
          </section>
        }
      >
        <ResolvedPricingState {...props} />
      </Suspense>
    </Container>
  );
}
