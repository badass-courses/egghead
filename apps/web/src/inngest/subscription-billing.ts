import { z } from "zod";

import { retrieveStripeEventCreatedAt, getStripeProvider } from "../coursebuilder/stripe-provider";
import {
  reportSubscriptionAlert,
  reportSubscriptionSkip,
  SUBSCRIPTION_DATA_ERROR_CODES,
  SubscriptionDataError,
} from "../subscriptions/alerts";
import { subscriptionSnapshotSchema, type SubscriptionSnapshot } from "../subscriptions/lifecycle";
import {
  decideEventOwnership,
  DeletedCustomerPendingError,
  routedEventSchema,
  type RoutedEvent,
} from "../subscriptions/ownership-seam";
import { loadStripeSubscriptionSnapshot } from "../subscriptions/stripe-billing";
import { getSubscriptionStore, type ReconcileOwnership } from "../subscriptions/store";
import {
  BILLING_SIGNAL_EVENT,
  SUBSCRIPTION_DELETED_EVENT,
} from "../subscriptions/webhook-contract";
import { membershipWritesAllowed } from "../subscriptions/write-policy";

/** The part of an Inngest step these handlers use; outputs are re-parsed after memoization. */
export type StepRun = (name: string, work: () => Promise<unknown>) => Promise<unknown>;

type ReconcileResult = Awaited<ReturnType<ReturnType<typeof getSubscriptionStore>["reconcile"]>>;
type SnapshotEvent = { id: string; kind: "subscription_update" | "subscription_deleted" };

/** Thrown while checkout has not written the local row yet; Inngest retries it. */
export class SubscriptionNotReadyError extends Error {
  constructor(message = "Local subscription is not ready for reconciliation") {
    super(message);
    this.name = "SubscriptionNotReadyError";
  }
}

export type SubscriptionBillingDeps = {
  writesAllowed: () => boolean;
  /** Decide the event's owner once (ADR-0001 §3); runs inside a memoized step. */
  routeEvent: (input: {
    eventId: string;
    eventCreated?: number;
    stripeSubscriptionId: string;
    stripeCustomerId: string | null;
  }) => Promise<RoutedEvent>;
  loadSnapshot: (
    stripeSubscriptionId: string,
    event: SnapshotEvent & { createdAt?: number },
  ) => Promise<SubscriptionSnapshot>;
  reconcile: (
    snapshot: SubscriptionSnapshot,
    ownership: ReconcileOwnership,
  ) => Promise<ReconcileResult>;
};

const subscriptionCustomerSchema = z.object({
  customer: z.union([z.string().min(1), z.object({ id: z.string().min(1) })]),
});

export const defaultSubscriptionBillingDeps: SubscriptionBillingDeps = {
  writesAllowed: membershipWritesAllowed,
  routeEvent: async ({ eventId, eventCreated, stripeSubscriptionId, stripeCustomerId }) => {
    const provider = getStripeProvider();
    if (!provider) throw new Error("Stripe is not configured");
    // Published update events omit their creation time; read it at this boundary.
    const created = eventCreated ?? (await retrieveStripeEventCreatedAt(provider, eventId));
    const customer =
      stripeCustomerId ??
      subscriptionCustomerSchema.parse(
        await provider.options.paymentsAdapter.getSubscription(stripeSubscriptionId),
      ).customer;
    return decideEventOwnership({
      eventId,
      eventCreated: created,
      stripeCustomerId: typeof customer === "string" ? customer : customer.id,
    });
  },
  loadSnapshot: (stripeSubscriptionId, event) => {
    const provider = getStripeProvider();
    if (!provider) throw new Error("Stripe is not configured");
    return loadStripeSubscriptionSnapshot(provider, stripeSubscriptionId, event);
  },
  reconcile: (snapshot, ownership) => getSubscriptionStore().reconcile(snapshot, ownership),
};

const dataCodeSchema = z.enum(SUBSCRIPTION_DATA_ERROR_CODES);
const failedSchema = z.object({ ok: z.literal(false), code: dataCodeSchema });
const loadedSchema = z.union([
  z.object({ ok: z.literal(true), value: subscriptionSnapshotSchema }),
  failedSchema,
]);
const reconciledSchema = z.union([
  z.object({
    ok: z.literal(true),
    value: z.object({ status: z.string(), subscriptionId: z.string().nullable().optional() }),
  }),
  failedSchema,
]);

/** Data errors become a value, so the step completes instead of retrying. */
async function captureDataError<T>(work: () => Promise<T>) {
  try {
    return { ok: true as const, value: await work() };
  } catch (error) {
    if (error instanceof SubscriptionDataError) return { ok: false as const, code: error.code };
    throw error;
  }
}

type Detail = Record<string, string | number | null | undefined>;

export function skipBlockedWrites(writesAllowed: () => boolean, detail: Detail) {
  if (writesAllowed()) return null;
  reportSubscriptionSkip("writes-blocked", detail);
  return { status: "skipped", reason: "writes-blocked" } as const;
}

/** Decide ownership once in a memoized step; the stored stamp answers every retry. */
/**
 * Wait, durably, for a deleted customer's `customer.deleted` record: an Inngest
 * `waitForEvent` on DELETED_CUSTOMER_RECORDED_EVENT with an hourly timeout. A
 * waiting run holds no concurrency slot and spends no retries.
 */
export type WaitForDeletedCustomer = (attempt: number) => Promise<unknown>;

/** Hourly checks past Stripe's three-day window, after which routing falls back on its own. */
export const MAX_DELETED_CUSTOMER_WAITS = 80;

const pendingRouteSchema = z.object({ pending: z.literal("deleted-customer") });
const routeStepSchema = z.union([routedEventSchema, pendingRouteSchema]);

/**
 * Decide ownership in a memoized step. While a deleted customer's record has not
 * arrived (ADR-0001 §14 L2), the step records `pending` instead of failing, the
 * run waits, and a new step routes again. After Stripe's retry window the seam
 * routes to Rails with `alert=deleted-customer-unrecorded`, which ends the wait.
 * Without `wait` (or past the cap) the pending error is thrown, as before.
 */
export async function routeEventStep(
  run: StepRun,
  route: () => Promise<RoutedEvent>,
  wait?: WaitForDeletedCustomer,
  attempt = 0,
): Promise<RoutedEvent> {
  const name =
    attempt === 0 ? "route event ownership" : `route event ownership after wait ${attempt}`;
  const result = routeStepSchema.parse(
    await run(name, async () => {
      try {
        return await route();
      } catch (error) {
        if (wait && error instanceof DeletedCustomerPendingError)
          return { pending: "deleted-customer" as const };
        throw error;
      }
    }),
  );
  if (!("pending" in result)) return result;
  if (!wait || attempt >= MAX_DELETED_CUSTOMER_WAITS) throw new DeletedCustomerPendingError();
  await wait(attempt + 1);
  return routeEventStep(run, route, wait, attempt + 1);
}

/** Acknowledge an event the other side owns. */
export function skipNotOwned(routing: RoutedEvent, detail: Detail) {
  if (routing.stamp.owner === "cb") return null;
  reportSubscriptionSkip("not-owner", { ...detail, owner: routing.stamp.owner });
  return { status: "not-owner", owner: routing.stamp.owner } as const;
}

/** Load billing in a memoized step; unsupported Stripe data is acknowledged and alerted. */
export async function loadSnapshotStep(
  run: StepRun,
  load: () => Promise<SubscriptionSnapshot>,
  detail: Detail,
) {
  const loaded = loadedSchema.parse(
    await run("load current subscription billing", () => captureDataError(load)),
  );
  if (loaded.ok) return { snapshot: loaded.value, skipped: null };
  reportSubscriptionSkip(loaded.code, detail);
  return { snapshot: null, skipped: { status: "skipped", reason: loaded.code } as const };
}

/**
 * Reconcile in a memoized step. Only a missing local row for a subscription we
 * own throws (and retries); not-owner and bad data are acknowledged.
 */
export async function reconcileStep(
  run: StepRun,
  name: string,
  reconcile: () => Promise<ReconcileResult>,
  detail: Detail,
  notReady: "retry" | "acknowledge" = "retry",
) {
  const outcome = reconciledSchema.parse(
    await run(name, async () => {
      const result = await captureDataError(reconcile);
      if (result.ok && result.value.status === "not-ready" && notReady === "retry")
        throw new SubscriptionNotReadyError();
      return result;
    }),
  );
  if (!outcome.ok) {
    reportSubscriptionSkip(outcome.code, detail);
    return { status: "skipped", reason: outcome.code } as const;
  }
  if (outcome.value.status === "not-owner") reportSubscriptionSkip("not-owner", detail);
  return outcome.value;
}

function objectField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * `onFailure` for the subscription functions: once Inngest gives up, say so.
 * A run that never found its local row gets `alert=not-ready-retries-exhausted`;
 * anything else gets `alert=retries-exhausted`. Only ids and the error name are
 * logged.
 */
export function alertOnRetriesExhausted({ error, event }: { error: unknown; event: unknown }) {
  const original = objectField(objectField(event, "data"), "event");
  const stripeEvent = objectField(objectField(original, "data"), "stripeEvent");
  const stripeEventId = objectField(stripeEvent, "id");
  const name = objectField(error, "name");
  const message = objectField(error, "message");
  const notReady =
    name === "SubscriptionNotReadyError" ||
    (typeof message === "string" && message.includes("not ready for"));
  reportSubscriptionAlert(notReady ? "not-ready-retries-exhausted" : "retries-exhausted", {
    function:
      typeof objectField(original, "name") === "string"
        ? String(objectField(original, "name"))
        : null,
    stripeEventId: typeof stripeEventId === "string" ? stripeEventId : null,
    error: typeof name === "string" ? name : "UnknownError",
  });
}

export type SubscriptionBillingEvent = {
  name: string;
  data: {
    stripeEvent: {
      id: string;
      created?: number;
      data: { object: { id: string; customer?: unknown } };
    };
    routing?: unknown;
  };
};

function customerOf(value: unknown) {
  if (typeof value === "string" && value) return value;
  const id = objectField(value, "id");
  return typeof id === "string" && id ? id : null;
}

/**
 * Handles `customer.subscription.updated`, the app-owned final cancellation, and
 * CB-owned dunning, refund and dispute signals (ADR-0001 §14 L4).
 */
export async function handleSubscriptionBillingEvent(
  event: SubscriptionBillingEvent,
  run: StepRun,
  deps: SubscriptionBillingDeps = defaultSubscriptionBillingDeps,
  waitForDeletedCustomer?: (stripeCustomerId: string, attempt: number) => Promise<unknown>,
) {
  const stripeEvent = event.data.stripeEvent;
  const stripeSubscriptionId = stripeEvent.data.object.id;
  const detail = { stripeEventId: stripeEvent.id, stripeSubscriptionId };
  const blocked = skipBlockedWrites(deps.writesAllowed, detail);
  if (blocked) return blocked;
  const deleted = event.name === SUBSCRIPTION_DELETED_EVENT;
  const signal = event.name === BILLING_SIGNAL_EVENT;
  // Deletions were routed at receipt; updates come from CourseBuilder's handler,
  // so they are routed here, once, in a memoized step.
  const carried = routedEventSchema.safeParse(event.data.routing);
  const stripeCustomerId = customerOf(stripeEvent.data.object.customer);
  const routing = carried.success
    ? carried.data
    : await routeEventStep(
        run,
        () =>
          deps.routeEvent({
            eventId: stripeEvent.id,
            ...(stripeEvent.created === undefined ? {} : { eventCreated: stripeEvent.created }),
            stripeSubscriptionId,
            stripeCustomerId,
          }),
        waitForDeletedCustomer && stripeCustomerId !== null
          ? (attempt) => waitForDeletedCustomer(stripeCustomerId, attempt)
          : undefined,
      );
  const notOwned = skipNotOwned(routing, detail);
  if (notOwned) return notOwned;
  // The routed creation time is the event's own, so no second Stripe read.
  const snapshotEvent = {
    id: stripeEvent.id,
    kind: deleted ? ("subscription_deleted" as const) : ("subscription_update" as const),
    createdAt: routing.eventCreated,
  };
  const { snapshot, skipped } = await loadSnapshotStep(
    run,
    () => deps.loadSnapshot(stripeSubscriptionId, snapshotEvent),
    detail,
  );
  if (!snapshot) return skipped;
  const reconciled = await reconcileStep(
    run,
    "reconcile subscription",
    () => deps.reconcile(snapshot, { owner: "cb", stripeCustomerId: routing.stripeCustomerId }),
    detail,
    // A signal only prompts a fresh read. With no local row (a charge from before
    // CB held this subscription, ADR §12), leave a receipt instead of retrying;
    // the subscription's own update events still retry while checkout catches up.
    signal ? "acknowledge" : "retry",
  );
  if (signal && reconciled.status === "not-ready") {
    reportSubscriptionAlert("unmatched-billing-signal", detail);
    return { status: "skipped", reason: "no-local-subscription" } as const;
  }
  return reconciled;
}
