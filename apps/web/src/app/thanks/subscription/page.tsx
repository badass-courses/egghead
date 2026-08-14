import Link from "next/link";
import { Suspense } from "react";
import { Container } from "@egghead/ui/container";

import { getCurrentUser } from "../../../coursebuilder/current-user";
import { getMembershipBillingSummary } from "../../../subscriptions/billing";
import { getCurrentSubscriptionForUser } from "../../../subscriptions/status";
import { MembershipStatusRefresh } from "./membership-status-refresh";

type SubscriptionThanksSearchParams = {
  provider?: string | string[];
  session_id?: string | string[];
};

const thanksPanelClassName =
  "mx-auto grid w-full max-w-[38rem] gap-6 rounded-[1.75rem] border border-border-strong bg-surface-grad p-6 shadow-card-deep sm:p-9";

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function formatMembershipDate(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function SubscriptionLoadingState() {
  return (
    <section aria-busy="true" className={`${thanksPanelClassName} text-center`}>
      <p className="font-bold text-muted-foreground">Checking your membership…</p>
    </section>
  );
}

async function ResolvedSubscriptionThanks({
  searchParams,
}: {
  searchParams: Promise<SubscriptionThanksSearchParams>;
}) {
  const [user, resolvedSearchParams] = await Promise.all([getCurrentUser(), searchParams]);
  const subscription = user?.id ? await getCurrentSubscriptionForUser(user.id) : null;
  const billingSummary =
    subscription && user?.id ? await getMembershipBillingSummary(user.id) : null;
  const checkoutSessionId = firstParam(resolvedSearchParams.session_id);
  const pendingActivation = Boolean(user && checkoutSessionId && !subscription);

  if (subscription) {
    return (
      <section aria-labelledby="subscription-thanks-heading" className={thanksPanelClassName}>
        <div className="text-center">
          <h1
            className="text-balance text-4xl font-black tracking-tight"
            id="subscription-thanks-heading"
          >
            Welcome to egghead.
          </h1>
          <p className="mt-3 text-pretty font-semibold text-muted-foreground">
            Your membership is active and the full egghead library is ready for you.
          </p>
          <p className="mt-4 flex items-center justify-center gap-2 text-sm font-extrabold">
            <span aria-hidden className="size-2.5 rounded-full bg-sage" />
            Membership active
          </p>
        </div>

        <dl className="grid gap-x-6 gap-y-4 border-y border-border py-5 text-left sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="text-xs font-extrabold text-muted-foreground">Access</dt>
            <dd className="mt-1 break-words font-extrabold">Full egghead library</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs font-extrabold text-muted-foreground">Billing</dt>
            <dd className="mt-1 break-words font-extrabold">
              {billingSummary?.cost ?? "Not available"}
              {billingSummary ? (
                <span className="font-bold text-muted-foreground">
                  {` · ${billingSummary.billingInterval}`}
                </span>
              ) : null}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs font-extrabold text-muted-foreground">
              {billingSummary?.cancelAtPeriodEnd ? "Access through" : "Renews"}
            </dt>
            <dd className="mt-1 break-words font-extrabold">
              {billingSummary
                ? formatMembershipDate(billingSummary.renewsAt)
                : "Billing details unavailable"}
            </dd>
          </div>
        </dl>

        {billingSummary?.cancelAtPeriodEnd ? (
          <p className="text-center text-sm font-bold text-rust">
            Your membership will not renew after {formatMembershipDate(billingSummary.renewsAt)}.
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          {billingSummary?.invoicePdfUrl ? (
            <a
              className="press inline-flex items-center justify-center rounded-xl border border-border-strong bg-surface-grad px-6 py-3 font-extrabold text-foreground shadow-btn-ghost"
              href={billingSummary.invoicePdfUrl}
              rel="noreferrer"
              target="_blank"
            >
              Download invoice
            </a>
          ) : null}
          <Link
            className="press inline-flex items-center justify-center rounded-xl border border-yolk-shadow/40 bg-yolk-grad px-7 pt-[15px] pb-[13px] font-extrabold text-yolk-foreground shadow-btn hover:shadow-btn-hover"
            href="/courses"
          >
            Browse courses
          </Link>
        </div>
      </section>
    );
  }

  if (pendingActivation) {
    return (
      <section
        aria-labelledby="subscription-thanks-heading"
        className={`${thanksPanelClassName} text-center`}
      >
        <h1
          className="text-balance text-4xl font-black tracking-tight"
          id="subscription-thanks-heading"
        >
          We’re activating your membership.
        </h1>
        <p className="text-pretty font-semibold text-muted-foreground">
          Payment received. Stripe has sent your subscription to egghead, and setup normally
          finishes in a few seconds.
        </p>
        <MembershipStatusRefresh />
      </section>
    );
  }

  const destination = user ? "/subscribe" : "/login?callbackUrl=/thanks/subscription";

  return (
    <section
      aria-labelledby="subscription-thanks-heading"
      className={`${thanksPanelClassName} text-center`}
    >
      <h1
        className="text-balance text-4xl font-black tracking-tight"
        id="subscription-thanks-heading"
      >
        {user ? "No active membership found." : "Sign in to check your membership."}
      </h1>
      <p className="text-pretty font-semibold text-muted-foreground">
        {user
          ? "Start a subscription to unlock all egghead courses and lessons."
          : "We’ll check your subscription status after you sign in."}
      </p>
      <Link
        className="press inline-flex items-center justify-center rounded-xl border border-yolk-shadow/40 bg-yolk-grad px-7 pt-[15px] pb-[13px] font-extrabold text-yolk-foreground shadow-btn hover:shadow-btn-hover"
        href={destination}
      >
        {user ? "View membership options" : "Sign in"}
      </Link>
    </section>
  );
}

export default function SubscriptionThanksPage({
  searchParams,
}: {
  searchParams: Promise<SubscriptionThanksSearchParams>;
}) {
  return (
    <Container
      as="main"
      className="content-center gap-y-0 py-[clamp(2.5rem,8vh,6rem)]"
      size="narrow"
    >
      <Suspense fallback={<SubscriptionLoadingState />}>
        <ResolvedSubscriptionThanks searchParams={searchParams} />
      </Suspense>
    </Container>
  );
}
