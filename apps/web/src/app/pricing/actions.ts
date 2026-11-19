"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentUser } from "../../coursebuilder/current-user";
import { safeErrorSummary } from "../../subscriptions/alerts";
import { createMembershipCheckout } from "../../subscriptions/checkout";
import { parseCheckoutSelection } from "../../subscriptions/checkout-selection";

export async function startSubscriptionCheckout(formData: FormData) {
  const user = await getCurrentUser();
  if (!user?.id) redirect("/login?callbackUrl=/pricing");
  if (!user.email) redirect("/pricing?error=missing-email");
  const parsed = parseCheckoutSelection(formData);
  if (parsed.status === "invalid") redirect(`/pricing?error=${parsed.error}`);
  const requestHeaders = await headers();
  let result: Awaited<ReturnType<typeof createMembershipCheckout>>;
  try {
    result = await createMembershipCheckout({
      ...parsed.selection,
      user: { id: user.id, email: user.email },
      requestOrigin: requestHeaders.get("origin"),
      country:
        requestHeaders.get("x-vercel-ip-country") ?? requestHeaders.get("cf-ipcountry") ?? "US",
    });
  } catch (error) {
    // Log what failed without customer data, then send the buyer back to pricing.
    console.error("Subscription checkout could not start", safeErrorSummary(error));
    redirect("/pricing?error=checkout");
  }
  if (result.status === "refused") {
    if (result.reason === "existing") redirect("/thanks/subscription?existing=true");
    redirect(`/pricing?error=${result.reason}`);
  }
  redirect(result.url);
}
