import Link from "next/link";
import { Container } from "@egghead/ui/container";

import { getCurrentUser } from "../../../coursebuilder/current-user";
import { getCurrentSubscriptionForUser } from "../../../subscriptions/status";

type SubscriptionThanksSearchParams = {
  provider?: string | string[];
  session_id?: string | string[];
};

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SubscriptionThanksPage({
  searchParams,
}: {
  searchParams: Promise<SubscriptionThanksSearchParams>;
}) {
  const [user, resolvedSearchParams] = await Promise.all([getCurrentUser(), searchParams]);
  const subscription = user?.id ? await getCurrentSubscriptionForUser(user.id) : null;
  const checkoutSessionId = firstParam(resolvedSearchParams.session_id);
  const checkoutProvider = firstParam(resolvedSearchParams.provider);
  const pendingActivation = Boolean(user && checkoutSessionId);
  const status = subscription
    ? {
        eyebrow: "membership active",
        heading: "You’re in.",
        message: "Your egghead access is ready. Pick a course and start learning.",
      }
    : pendingActivation
      ? {
          eyebrow: "payment received",
          heading: "We’re activating your membership.",
          message:
            "Stripe has sent your subscription to egghead. This normally finishes in a few seconds.",
        }
      : user
        ? {
            eyebrow: "membership status",
            heading: "No active membership found.",
            message: "Start a subscription to unlock all egghead courses and lessons.",
          }
        : {
            eyebrow: "sign in required",
            heading: "Sign in to check your membership.",
            message: "We’ll check your subscription status after you sign in.",
          };

  const destination = subscription
    ? "/courses"
    : pendingActivation && checkoutSessionId
      ? {
          pathname: "/thanks/subscription",
          query: {
            session_id: checkoutSessionId,
            ...(checkoutProvider ? { provider: checkoutProvider } : {}),
            check: Date.now(),
          },
        }
      : user
        ? "/subscribe"
        : "/login?callbackUrl=/thanks/subscription";

  return (
    <Container
      as="main"
      className="content-center gap-y-0 py-[clamp(2.5rem,8vh,6rem)]"
      size="narrow"
    >
      <section className="mx-auto grid w-full max-w-[34rem] gap-6 rounded-[1.75rem] border border-border-strong bg-surface-grad p-6 text-center shadow-card-deep sm:p-9">
        <p className="eyebrow">{status.eyebrow}</p>
        <h1 className="text-balance text-4xl font-black tracking-tight">{status.heading}</h1>
        <p className="text-pretty font-semibold text-muted-foreground">{status.message}</p>
        <Link
          className="press inline-flex items-center justify-center rounded-xl border border-yolk-shadow/40 bg-yolk-grad px-7 pt-[15px] pb-[13px] font-extrabold text-yolk-foreground shadow-btn hover:shadow-btn-hover"
          href={destination}
          prefetch={false}
        >
          {subscription
            ? "Browse courses"
            : pendingActivation
              ? "Check again"
              : user
                ? "View membership options"
                : "Sign in"}
        </Link>
      </section>
    </Container>
  );
}
