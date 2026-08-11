import Link from "next/link";
import { Suspense } from "react";
import { Button } from "@egghead/ui/button";
import { Container } from "@egghead/ui/container";

import { getCurrentUser } from "../../coursebuilder/current-user";
import { isStripeConfigured } from "../../coursebuilder/stripe-provider";
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

const subscriptionPanelClassName =
  "mx-auto grid w-full max-w-[36rem] gap-7 rounded-[1.75rem] border border-border-strong bg-surface-grad p-6 shadow-card-deep sm:p-9";

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
  const [user, resolvedSearchParams] = await Promise.all([getCurrentUser(), searchParams]);
  const currentSubscription = user?.id ? await getCurrentSubscriptionForUser(user.id) : null;
  const configured = Boolean(isStripeConfigured() && getEnv("EGGHEAD_SUBSCRIPTION_PRODUCT_ID"));
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

      <ul className="grid gap-3 rounded-2xl border border-border-strong bg-well p-5 font-bold shadow-well">
        <li>✓ Full course and lesson access</li>
        <li>✓ New material as it ships</li>
        <li>✓ One membership for your egghead account</li>
      </ul>

      {errorMessage ? (
        <p
          className="rounded-xl border border-rust/40 bg-rust/10 px-4 py-3 text-sm font-bold text-rust"
          role="alert"
        >
          {errorMessage}
        </p>
      ) : null}

      {currentSubscription ? (
        <div className="grid gap-3 text-center">
          <p className="font-extrabold text-sage-foreground">Your membership is active.</p>
          <Link
            className="press inline-flex items-center justify-center rounded-xl border border-border-strong bg-surface-grad px-7 pt-[15px] pb-[13px] font-extrabold shadow-btn-ghost"
            href="/courses"
          >
            Browse courses
          </Link>
        </div>
      ) : user ? (
        <form action={startSubscriptionCheckout} className="grid gap-3">
          <Button className="w-full" disabled={!configured} size="lg" type="submit">
            Continue to Stripe
          </Button>
          <p className="text-center text-xs font-semibold text-muted-foreground">
            You’ll review the price and billing interval before subscribing.
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
