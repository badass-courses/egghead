import Link from "next/link";
import { Suspense } from "react";
import { Button } from "@egghead/ui/button";
import { Container } from "@egghead/ui/container";

import { getCurrentUser } from "../../coursebuilder/current-user";
import { isStripeConfigured } from "../../coursebuilder/stripe-provider";
import { commerceWritesAreAllowed } from "../../db/local-docker";
import { getCourseBuilderAdapter } from "../../db/adapter";
import { getEnv } from "../../env";
import { getCurrentSubscriptionForUser } from "../../subscriptions/status";
import { startSubscriptionCheckout } from "./actions";

type SubscribeSearchParams = {
  error?: string | string[];
};

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function checkoutErrorMessage(error: string | undefined) {
  if (error === "missing-email") return "Your account needs an email address before checkout.";
  if (error === "not-configured") return "Subscription checkout is not configured yet.";
  if (error === "checkout") return "Stripe could not start checkout. Please try again.";
  return null;
}

const usdPriceFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

async function getSubscriptionOption(productId: string | undefined) {
  if (!productId) return null;

  const product = await getCourseBuilderAdapter().getProduct(productId, false);
  if (!product || product.type !== "membership" || !product.price || product.price.status !== 1) {
    return null;
  }

  const billingInterval = product.fields.billingInterval === "month" ? "month" : "year";

  return {
    name: product.name,
    description: product.fields.description,
    price: usdPriceFormatter.format(product.price.unitAmount),
    billingInterval,
  };
}

const subscriptionPanelClassName =
  "mx-auto grid w-full max-w-[44rem] gap-7 rounded-[1.75rem] border border-border-strong bg-surface-grad p-6 shadow-card-deep sm:p-9";

function SubscribeLoadingState() {
  return (
    <section aria-busy="true" className={subscriptionPanelClassName}>
      <p className="text-center font-bold text-muted-foreground">Checking your membership…</p>
    </section>
  );
}

async function ResolvedSubscriptionState({
  searchParams,
}: {
  searchParams: Promise<SubscribeSearchParams>;
}) {
  const productId = getEnv("EGGHEAD_SUBSCRIPTION_PRODUCT_ID");
  const [user, resolvedSearchParams, subscriptionOption] = await Promise.all([
    getCurrentUser(),
    searchParams,
    getSubscriptionOption(productId),
  ]);
  const currentSubscription = user?.id ? await getCurrentSubscriptionForUser(user.id) : null;
  const configured = Boolean(isStripeConfigured() && productId);
  const commerceWritesAllowed = commerceWritesAreAllowed();
  const checkoutAvailable = configured && commerceWritesAllowed;
  const errorMessage = checkoutErrorMessage(firstParam(resolvedSearchParams.error));

  return (
    <section className={subscriptionPanelClassName}>
      <header className="grid gap-3 text-center">
        <p className="eyebrow">egghead membership</p>
        <h1 className="text-balance text-4xl font-black tracking-tight">
          Learn without the paywalls.
        </h1>
        <p className="text-pretty text-lg font-semibold text-muted-foreground">
          Get full access to egghead courses and lessons with a recurring membership. Checkout is
          securely hosted by Stripe.
        </p>
      </header>

      {errorMessage ? (
        <p
          className="rounded-xl border border-rust/40 bg-rust/10 px-4 py-3 text-sm font-bold text-rust"
          role="alert"
        >
          {errorMessage}
        </p>
      ) : null}

      {currentSubscription ? (
        <div className="grid gap-3 rounded-2xl border border-sage-line bg-sage-wash p-5 text-center">
          <p className="font-extrabold text-sage-foreground">Your membership is active.</p>
          <Link
            className="press inline-flex items-center justify-center rounded-xl border border-border-strong bg-surface-grad px-7 pt-[15px] pb-[13px] font-extrabold shadow-btn-ghost"
            href="/courses"
          >
            Browse courses
          </Link>
        </div>
      ) : (
        <div aria-label="Subscription options" className="mx-auto w-full max-w-[32rem]">
          <article className="overflow-hidden rounded-2xl border border-border-strong bg-well shadow-well">
            <div className="grid gap-5 border-b border-border-strong bg-surface-grad p-6 text-center sm:p-8">
              <div className="grid gap-1">
                <p className="text-xs font-black uppercase tracking-wider text-rust">For myself</p>
                <h2 className="text-balance text-2xl font-black tracking-tight">
                  {subscriptionOption?.name ?? "egghead membership"}
                </h2>
                <p className="text-sm font-semibold text-muted-foreground">
                  {subscriptionOption?.description ?? "Unlimited learning for one egghead account."}
                </p>
              </div>

              {subscriptionOption ? (
                <p
                  className="flex items-end justify-center gap-1"
                  aria-label={`${subscriptionOption.price} per ${subscriptionOption.billingInterval}`}
                >
                  <span className="mb-7 text-sm font-extrabold text-muted-foreground">US</span>
                  <span className="text-5xl font-black tracking-tight sm:text-6xl">
                    {subscriptionOption.price}
                  </span>
                  <span className="mb-2 text-lg font-extrabold text-muted-foreground">
                    /{subscriptionOption.billingInterval}
                  </span>
                </p>
              ) : (
                <p className="text-lg font-extrabold text-muted-foreground">
                  Price shown at checkout
                </p>
              )}

              {user ? (
                <form action={startSubscriptionCheckout} className="grid gap-3">
                  <Button className="w-full" disabled={!checkoutAvailable} size="lg" type="submit">
                    Subscribe
                  </Button>
                  <p className="text-xs font-semibold text-muted-foreground">
                    {!commerceWritesAllowed
                      ? "Checkout is limited to local Docker during Phase 0."
                      : configured
                        ? `Billed every ${subscriptionOption?.billingInterval ?? "billing period"}. Cancel anytime.`
                        : "Subscription checkout is not configured yet."}
                  </p>
                </form>
              ) : (
                <Link
                  className="press inline-flex items-center justify-center rounded-full border border-yolk-shadow/40 bg-yolk-grad px-9 pt-[17px] pb-[15px] text-lg font-extrabold text-yolk-foreground shadow-btn hover:shadow-btn-hover"
                  href="/login?callbackUrl=/subscribe"
                >
                  Sign in to subscribe
                </Link>
              )}
            </div>

            <div className="grid gap-4 p-6 sm:p-8">
              <p className="font-extrabold">Includes</p>
              <ul className="grid gap-3 font-bold">
                <li className="flex gap-3">
                  <span aria-hidden="true" className="text-sage-foreground">
                    ✓
                  </span>
                  Full course and lesson access
                </li>
                <li className="flex gap-3">
                  <span aria-hidden="true" className="text-sage-foreground">
                    ✓
                  </span>
                  New material as it ships
                </li>
                <li className="flex gap-3">
                  <span aria-hidden="true" className="text-sage-foreground">
                    ✓
                  </span>
                  Progress saved to your egghead account
                </li>
              </ul>
            </div>
          </article>
          <p className="mt-4 text-center text-xs font-semibold text-muted-foreground">
            Secure checkout powered by Stripe.
          </p>
        </div>
      )}
    </section>
  );
}

export default function SubscribePage({
  searchParams,
}: {
  searchParams: Promise<SubscribeSearchParams>;
}) {
  return (
    <Container
      as="main"
      className="content-center gap-y-0 py-[clamp(2.5rem,8vh,6rem)]"
      size="narrow"
    >
      <Suspense fallback={<SubscribeLoadingState />}>
        <ResolvedSubscriptionState searchParams={searchParams} />
      </Suspense>
    </Container>
  );
}
