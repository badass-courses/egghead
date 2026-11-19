import { assertCommerceWritesAllowed } from "../db/local-docker";
import { getEnv } from "../env";
import { FixedMessageError } from "./alerts";

export function assertMembershipWritesAllowed() {
  const safety = assertCommerceWritesAllowed();
  if (safety.runtime !== "local" || !safety.localDockerOnly)
    throw new FixedMessageError("Membership lifecycle writes require local Docker");
  // The same key the CourseBuilder Stripe provider reads (coursebuilder/stripe-provider.ts).
  const token = getEnv("STRIPE_SECRET_TOKEN");
  if (!token || (!token.startsWith("sk_test_") && !token.startsWith("rk_test_")))
    throw new FixedMessageError("Local membership writes require a Stripe test key");
}

/**
 * Non-throwing form for event handlers. Where writes are blocked (beta and
 * production today) Stripe and Inngest events are acknowledged and skipped,
 * because a blocked environment is a no-op, not an error to retry.
 */
export function membershipWritesAllowed() {
  try {
    assertMembershipWritesAllowed();
    return true;
  } catch {
    return false;
  }
}
