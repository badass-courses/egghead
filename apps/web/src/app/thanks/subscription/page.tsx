import Link from "next/link";
import { Suspense } from "react";
import { Container } from "@egghead/ui/container";

import { getCurrentUser } from "../../../coursebuilder/current-user";
import { getCurrentSubscriptionForUser } from "../../../subscriptions/status";

const thanksPanelClassName =
  "mx-auto grid w-full max-w-[34rem] gap-6 rounded-[1.75rem] border border-border-strong bg-surface-grad p-6 text-center shadow-card-deep sm:p-9";

function SubscriptionLoadingState() {
  return (
    <section aria-busy="true" className={thanksPanelClassName}>
      <p className="font-bold text-muted-foreground">Checking your membership…</p>
    </section>
  );
}

async function ResolvedSubscriptionThanks() {
  const user = await getCurrentUser();
  const subscription = user?.id ? await getCurrentSubscriptionForUser(user.id) : null;

  return (
    <section className={thanksPanelClassName}>
      <p className="eyebrow">{subscription ? "membership active" : "payment received"}</p>
      <h1 className="text-balance text-4xl font-black tracking-tight">
        {subscription ? "You’re in." : "We’re activating your membership."}
      </h1>
      <p className="text-pretty font-semibold text-muted-foreground">
        {subscription
          ? "Your egghead access is ready. Pick a course and start learning."
          : "Stripe has sent your subscription to egghead. This normally finishes in a few seconds."}
      </p>
      <Link
        className="press inline-flex items-center justify-center rounded-xl border border-yolk-shadow/40 bg-yolk-grad px-7 pt-[15px] pb-[13px] font-extrabold text-yolk-foreground shadow-btn hover:shadow-btn-hover"
        href={subscription ? "/courses" : "/thanks/subscription"}
        prefetch={false}
      >
        {subscription ? "Browse courses" : "Check again"}
      </Link>
    </section>
  );
}

export default function SubscriptionThanksPage() {
  return (
    <Container
      as="main"
      className="content-center gap-y-0 py-[clamp(2.5rem,8vh,6rem)]"
      size="narrow"
    >
      <Suspense fallback={<SubscriptionLoadingState />}>
        <ResolvedSubscriptionThanks />
      </Suspense>
    </Container>
  );
}
