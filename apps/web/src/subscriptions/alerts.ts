// Subscription events that must be acknowledged rather than retried. Stripe and
// Inngest retry anything that throws; for data that can never succeed, or for an
// environment where writes are blocked, a retry only burns the budget and pages
// nobody. These helpers log a stable, grep-able line instead.

export const SUBSCRIPTION_DATA_ERROR_CODES = [
  "unsupported-stripe-shape",
  "unknown-subscription-status",
  "invalid-grant-metadata",
  "invalid-subscription-state",
  "incomplete-subscription-row",
  "roster-budget-exceeded",
  "stripe-id-mismatch",
  "customer-mismatch",
] as const;
export type SubscriptionDataErrorCode = (typeof SUBSCRIPTION_DATA_ERROR_CODES)[number];

/** Data that no retry can fix. Callers acknowledge, alert and skip. */
export class SubscriptionDataError extends Error {
  readonly code: SubscriptionDataErrorCode;

  constructor(code: SubscriptionDataErrorCode, message: string) {
    super(message);
    this.name = "SubscriptionDataError";
    this.code = code;
  }
}

type Detail = Record<string, string | number | null | undefined>;

export type SubscriptionSkipReason = "writes-blocked" | "not-owner" | SubscriptionDataErrorCode;

/**
 * Record a routine support receipt (a refund or dispute CB handled) at info, so it
 * never drowns the alerts.
 */
export function reportSubscriptionReceipt(code: string, detail: Detail = {}) {
  console.info(`[egghead-subscriptions] receipt=${code} ${JSON.stringify(detail)}`);
}

/** Record something worth a human look that does not stop the event. */
export function reportSubscriptionAlert(code: string, detail: Detail = {}) {
  console.error(`[egghead-subscriptions] alert=${code} ${JSON.stringify(detail)}`);
}

function stringField(value: object, key: string) {
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" ? field : null;
}

/**
 * An error our own code throws with a fixed, customer-free message. Only these
 * messages are logged: a plain `Error` can come from mysql2 ("Duplicate entry
 * 'someone@example.test' for key ...") or any library, so its prototype says
 * nothing about what its message holds.
 */
export class FixedMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixedMessageError";
  }
}

/**
 * Loggable facts about a thrown error, with no customer data: always its name,
 * plus `type`, `code` and `decline_code` when present (Stripe). The message only
 * for a `FixedMessageError`.
 */
export function safeErrorSummary(error: unknown) {
  if (typeof error !== "object" || error === null)
    return { name: "UnknownError", type: null, code: null, declineCode: null, message: null };
  return {
    name: stringField(error, "name") ?? "UnknownError",
    type: stringField(error, "type"),
    code: stringField(error, "code"),
    declineCode: stringField(error, "decline_code"),
    message: error instanceof FixedMessageError ? error.message : null,
  };
}

/** Record an acknowledged, skipped subscription event. Data problems log as errors. */
export function reportSubscriptionSkip(reason: SubscriptionSkipReason, detail: Detail = {}) {
  const line = `[egghead-subscriptions] skipped reason=${reason} ${JSON.stringify(detail)}`;
  if (reason === "writes-blocked" || reason === "not-owner") console.warn(line);
  else console.error(`${line} alert=true`);
}
