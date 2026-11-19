// Access law is an input to the ownership machine, not a decision it makes.
// ADR-0006 (Rails' lenient status law) and ADR-0008 (strict paid-through) both exist;
// which one CourseBuilder enforces at the writer flip is decided separately. The
// machine only uses a rule to refuse a handover that would silently change a
// subscriber's access on the day it moves.

export type StripeSubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "unpaid"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "paused";

export interface AccessFacts {
  readonly status: StripeSubscriptionStatus;
  /** Paid-through boundary (Stripe current_period_end), epoch seconds. */
  readonly paidThroughAt: number | null;
  /** Evaluation time, epoch seconds. */
  readonly now: number;
}

export type AccessResult = "status_grant" | "status_no_grant" | "paid_through" | "not_paid_through";

export interface AccessRule {
  readonly name: string;
  readonly evaluate: (facts: AccessFacts) => AccessResult;
}

export function accessGranted(result: AccessResult): boolean {
  return result === "status_grant" || result === "paid_through";
}

const railsEnabledStatuses: ReadonlySet<StripeSubscriptionStatus> = new Set([
  "active",
  "trialing",
  "past_due",
]);

/** ADR-0006: Rails' enabled scope. Status alone grants; the period end is ignored. */
export const lenientStatusRule: AccessRule = {
  name: "adr-0006-lenient-status",
  evaluate: ({ status }) => (railsEnabledStatuses.has(status) ? "status_grant" : "status_no_grant"),
};

/** ADR-0008: only an active subscription inside its paid period grants. */
export const strictPaidThroughRule: AccessRule = {
  name: "adr-0008-strict-paid-through",
  evaluate: ({ status, paidThroughAt, now }) =>
    status === "active" && paidThroughAt !== null && paidThroughAt > now
      ? "paid_through"
      : "not_paid_through",
};
