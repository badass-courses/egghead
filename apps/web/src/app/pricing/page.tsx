import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { Container } from "@egghead/ui/container";

import { getCurrentUser } from "../../coursebuilder/current-user";
import { isStripeConfigured } from "../../coursebuilder/stripe-provider";
import { commerceWritesAreAllowed } from "../../db/local-docker";
import { formatProductPrice } from "../../subscriptions/billing";
import {
  getActiveMembershipProducts,
  type ActiveMembershipProduct,
} from "../../subscriptions/catalog";
import { compareSubscriptionIntervals } from "../../subscriptions/options";
import { getCurrentSubscriptionForUser } from "../../subscriptions/status";
import { getOwnedTeamSubscription } from "../../subscriptions/team";
import { SubscriptionOptions, type SubscriptionOption } from "./subscription-options";

type PricingSearchParams = {
  error?: string | string[];
};

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function checkoutErrorMessage(error: string | undefined) {
  if (error === "missing-email") return "Your account needs an email address before checkout.";
  if (error === "invalid-product") return "That membership option is no longer available.";
  if (error === "invalid-seats") return "Choose between 1 and 100 membership seats.";
  if (error === "not-configured") return "Subscription checkout is not configured yet.";
  if (error === "checkout") return "Stripe could not start checkout. Please try again.";
  if (error === "checkout-pending") {
    return "Another membership checkout is already in progress.";
  }
  return null;
}

function getSubscriptionOption(product: ActiveMembershipProduct): SubscriptionOption | null {
  const price = formatProductPrice(product.price.unitAmount, "USD");
  if (!price) return null;

  return {
    productId: product.id,
    name: product.name,
    description: product.fields.description ?? null,
    currency: "USD",
    price,
    unitAmount: product.price.unitAmount,
    billingInterval: product.fields.billingInterval,
  };
}

function getSubscriptionOptions(products: ActiveMembershipProduct[]) {
  return products
    .map(getSubscriptionOption)
    .filter((option): option is SubscriptionOption => option !== null)
    .toSorted((first, second) =>
      compareSubscriptionIntervals(first.billingInterval, second.billingInterval),
    );
}

const subscriptionPanelClassName = "mx-auto grid w-full max-w-[44rem] gap-7";

function PricingLoadingState() {
  return (
    <section aria-busy="true" className={subscriptionPanelClassName}>
      <p className="text-center font-bold text-muted-foreground">Checking your membership…</p>
    </section>
  );
}

async function ResolvedPricingState({
  searchParams,
}: {
  searchParams: Promise<PricingSearchParams>;
}) {
  await connection();

  const [user, resolvedSearchParams, membershipProducts] = await Promise.all([
    getCurrentUser(),
    searchParams,
    getActiveMembershipProducts(),
  ]);
  const subscriptionOptions = getSubscriptionOptions(membershipProducts);
  const [currentSubscription, teamSubscription] = user?.id
    ? await Promise.all([getCurrentSubscriptionForUser(user.id), getOwnedTeamSubscription(user.id)])
    : [null, null];
  const configured = isStripeConfigured() && subscriptionOptions.length > 0;
  const commerceWritesAllowed = commerceWritesAreAllowed();
  const checkoutAvailable = configured && commerceWritesAllowed;
  const errorMessage = checkoutErrorMessage(firstParam(resolvedSearchParams.error));

  return (
    <section className={subscriptionPanelClassName}>
      <header className="grid gap-3 text-center">
        <h1 className="text-balance text-4xl font-black tracking-tight">
          Learn without the paywalls.
        </h1>
        <p className="text-pretty text-lg font-semibold text-muted-foreground">
          Choose monthly or yearly access to every egghead course and lesson. Checkout is securely
          hosted by Stripe.
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
        <div className="grid gap-3 rounded-2xl bg-sage-wash p-5 text-center shadow-well">
          <p className="font-extrabold text-sage-foreground">Your membership is active.</p>
          <Link
            className="press inline-flex items-center justify-center rounded-xl border border-border-strong bg-surface-grad px-7 pt-[15px] pb-[13px] font-extrabold shadow-btn-ghost"
            href={teamSubscription ? "/team" : "/courses"}
          >
            {teamSubscription ? "Manage team seats" : "Browse courses"}
          </Link>
        </div>
      ) : subscriptionOptions.length > 0 ? (
        <div aria-label="Subscription options" className="mx-auto w-full max-w-[32rem]">
          <SubscriptionOptions
            checkoutAvailable={checkoutAvailable}
            commerceWritesAllowed={commerceWritesAllowed}
            configured={configured}
            options={subscriptionOptions}
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
            No active recurring membership products are configured. Please try again later.
          </p>
        </div>
      )}
    </section>
  );
}

export default function PricingPage({
  searchParams,
}: {
  searchParams: Promise<PricingSearchParams>;
}) {
  return (
    <Container
      as="main"
      className="content-center gap-y-0 py-[clamp(2.5rem,8vh,6rem)]"
      size="narrow"
    >
      <Suspense fallback={<PricingLoadingState />}>
        <ResolvedPricingState searchParams={searchParams} />
      </Suspense>
    </Container>
  );
}
