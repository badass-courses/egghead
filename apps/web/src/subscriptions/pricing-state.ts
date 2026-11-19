import { membershipWritesAllowed } from "./write-policy";

export type PricingPanel = "current" | "paused" | "closed" | "options" | "unavailable";

/**
 * What the pricing page offers. Checkout only opens where the membership writer
 * can fulfil it; elsewhere (beta and production until cutover) the page shows a
 * plain closed state instead of a Subscribe button that would always fail.
 */
export function pricingPanel(input: {
  hasCurrentSubscription: boolean;
  optionCount: number;
  checkoutOpen?: boolean;
  /**
   * The current subscription is a team this user owns and its access is paused
   * until they pick who keeps a seat (an unplanned seat reduction).
   */
  ownedTeamPaused?: boolean;
}): PricingPanel {
  if (input.hasCurrentSubscription && input.ownedTeamPaused) return "paused";
  if (input.hasCurrentSubscription) return "current";
  if (!(input.checkoutOpen ?? membershipWritesAllowed())) return "closed";
  return input.optionCount > 0 ? "options" : "unavailable";
}
