import { NEW_SUBSCRIPTION_CREATED_EVENT } from "@coursebuilder/core/events/commerce";
import { STRIPE_CHECKOUT_SESSION_COMPLETED_EVENT } from "@coursebuilder/core/events/stripe";
import { STRIPE_CUSTOMER_SUBSCRIPTION_UPDATED_EVENT } from "@coursebuilder/core/events/stripe";
import { parseSubscriptionInfoFromCheckoutSession } from "@coursebuilder/commerce/stripe-subscription-utils";
import { checkoutSessionCompletedEvent } from "@coursebuilder/core/schemas/stripe/checkout-session-completed";
import { eq } from "drizzle-orm";

import { getStripeProvider } from "../coursebuilder/stripe-provider";
import { getCourseBuilderAdapter, getEggheadDatabase } from "../db/adapter";
import {
  merchantAccount as merchantAccountTable,
  merchantSubscription,
  subscription,
} from "../db/schema";
import type { SubscriptionSnapshot } from "../subscriptions/lifecycle";
import { decideEventOwnership, type RoutedEvent } from "../subscriptions/ownership-seam";
import { ensurePersonalOrganization } from "../subscriptions/personal-organization";
import { loadStripeSubscriptionSnapshot } from "../subscriptions/stripe-billing";
import { getSubscriptionStore, type ReconcileOwnership } from "../subscriptions/store";
import {
  BILLING_SIGNAL_EVENT,
  DELETED_CUSTOMER_RECORDED_EVENT,
  SUBSCRIPTION_DELETED_EVENT,
} from "../subscriptions/webhook-contract";
import { membershipWritesAllowed } from "../subscriptions/write-policy";
import { inngest } from "./client";
import {
  alertOnRetriesExhausted,
  handleSubscriptionBillingEvent,
  loadSnapshotStep,
  reconcileStep,
  routeEventStep,
  skipBlockedWrites,
  skipNotOwned,
  type StepRun,
} from "./subscription-billing";

type ReconcileResult = Awaited<ReturnType<ReturnType<typeof getSubscriptionStore>["reconcile"]>>;

/** One hourly wait for a deleted customer's record (see `WaitForDeletedCustomer`). */
function waitForDeletionRecord(
  step: {
    waitForEvent: (
      name: string,
      options: { event: typeof DELETED_CUSTOMER_RECORDED_EVENT; timeout: string; if: string },
    ) => Promise<unknown>;
  },
  stripeCustomerId: string,
  attempt: number,
) {
  return step.waitForEvent(`wait for deleted customer record ${attempt}`, {
    event: DELETED_CUSTOMER_RECORDED_EVENT,
    timeout: "1h",
    if: `async.data.stripeCustomerId == ${JSON.stringify(stripeCustomerId)}`,
  });
}

export type CheckoutCompletedDeps<
  Info extends { customerIdentifier: string; subscriptionIdentifier: string },
> = {
  writesAllowed: () => boolean;
  /** The expanded session's subscription info, read in memoized steps. */
  loadSubscriptionInfo: (stripeCheckoutSessionId: string) => Promise<Info>;
  routeEvent: (input: {
    eventId: string;
    eventCreated: number;
    stripeCustomerId: string;
  }) => Promise<RoutedEvent>;
  /**
   * Every merchant, customer, session and subscription row checkout creates, in
   * memoized steps; `announce` sends NEW_SUBSCRIPTION_CREATED_EVENT.
   */
  createRows: (
    subscriptionInfo: Info,
    stripeCheckoutSessionId: string,
  ) => Promise<{ subscriptionId: string; announce: () => Promise<unknown> }>;
  loadSnapshot: (
    stripeSubscriptionId: string,
    event: { id: string; createdAt: number; kind: "checkout" },
  ) => Promise<SubscriptionSnapshot>;
  reconcile: (
    snapshot: SubscriptionSnapshot,
    ownership: ReconcileOwnership,
  ) => Promise<ReconcileResult>;
  /** Durable wait while the customer's `customer.deleted` record is pending. */
  waitForDeletedCustomer?: (stripeCustomerId: string, attempt: number) => Promise<unknown>;
};

/**
 * A completed subscription checkout: route by the customer's marker before any
 * row exists, create the rows, reconcile the first observation, and announce the
 * subscription unless that reconciliation found another owner or skipped
 * undecodable data. An `unchanged` reconcile still announces: an update event
 * for the same subscription may have applied first, and the checkout is still
 * the subscription's creation. The function's idempotency key (the session id)
 * keeps it to one announcement.
 */
export async function handleCheckoutSessionCompleted<
  Info extends { customerIdentifier: string; subscriptionIdentifier: string },
>(stripeEventInput: unknown, run: StepRun, deps: CheckoutCompletedDeps<Info>) {
  const stripeEvent = checkoutSessionCompletedEvent.parse(stripeEventInput);
  const stripeCheckoutSession = stripeEvent.data.object;
  const checkoutDetail = {
    stripeEventId: stripeEvent.id,
    stripeCheckoutSessionId: stripeCheckoutSession.id,
  };
  // Beta and production cannot write memberships: acknowledge, never retry.
  const blocked = skipBlockedWrites(deps.writesAllowed, checkoutDetail);
  if (blocked) return blocked;
  const subscriptionInfo = await deps.loadSubscriptionInfo(stripeCheckoutSession.id);
  const detail = {
    stripeEventId: stripeEvent.id,
    stripeSubscriptionId: subscriptionInfo.subscriptionIdentifier,
  };
  // Route by the customer's ownership marker, once, before creating any
  // merchant, customer or subscription rows (ADR-0001 §2–3).
  const waitForDeletedCustomer = deps.waitForDeletedCustomer;
  const routing = await routeEventStep(
    run,
    () =>
      deps.routeEvent({
        eventId: stripeEvent.id,
        eventCreated: stripeEvent.created,
        stripeCustomerId: subscriptionInfo.customerIdentifier,
      }),
    waitForDeletedCustomer
      ? (attempt) => waitForDeletedCustomer(subscriptionInfo.customerIdentifier, attempt)
      : undefined,
  );
  const notOwned = skipNotOwned(routing, detail);
  if (notOwned) return notOwned;
  const rows = await deps.createRows(subscriptionInfo, stripeCheckoutSession.id);
  const { snapshot, skipped } = await loadSnapshotStep(
    run,
    () =>
      deps.loadSnapshot(subscriptionInfo.subscriptionIdentifier, {
        id: stripeEvent.id,
        createdAt: stripeEvent.created,
        kind: "checkout",
      }),
    detail,
  );
  if (!snapshot) return skipped;
  const reconciliation = await reconcileStep(
    run,
    "reconcile initial subscription",
    () => deps.reconcile(snapshot, { owner: "cb", stripeCustomerId: routing.stripeCustomerId }),
    detail,
  );
  // Not owned or undecodable: acknowledge without announcing access.
  if (reconciliation.status === "not-owner" || reconciliation.status === "skipped")
    return reconciliation;
  await rows.announce();
  return {
    seatCount: snapshot.seats,
    subscriptionId: rows.subscriptionId,
    status: snapshot.status,
  };
}

export const stripeSubscriptionCheckoutSessionComplete = inngest.createFunction(
  {
    id: "stripe-subscription-checkout-session-completed",
    name: "Stripe Subscription Checkout Session Completed",
    idempotency: "event.data.stripeEvent.data.object.id",
    onFailure: alertOnRetriesExhausted,
  },
  {
    event: STRIPE_CHECKOUT_SESSION_COMPLETED_EVENT,
    if: "event.data.stripeEvent.data.object.mode == 'subscription'",
  },
  async ({ event, step }) => {
    const stripeCheckoutSession = checkoutSessionCompletedEvent.parse(event.data.stripeEvent).data
      .object;
    const stripeProvider = getStripeProvider();
    const adapter = getCourseBuilderAdapter();
    const db = getEggheadDatabase();
    const requireProvider = () => {
      if (!stripeProvider) throw new Error("Stripe is not configured.");
      return stripeProvider;
    };
    return handleCheckoutSessionCompleted(
      event.data.stripeEvent,
      (name, work) => step.run(name, work),
      {
        writesAllowed: membershipWritesAllowed,
        loadSubscriptionInfo: async () => {
          const provider = requireProvider();
          const checkoutSession = await step.run("load expanded checkout session", () =>
            provider.options.paymentsAdapter.getCheckoutSession(stripeCheckoutSession.id),
          );
          const subscriptionInfo = await step.run("parse subscription checkout", () =>
            parseSubscriptionInfoFromCheckoutSession(checkoutSession),
          );
          return subscriptionInfo;
        },
        routeEvent: (input) => decideEventOwnership(input),
        createRows: async (subscriptionInfo) => {
          const merchantProduct = await step.run("load merchant product", () =>
            adapter.getMerchantProduct(subscriptionInfo.productIdentifier),
          );
          if (!merchantProduct || merchantProduct.status !== 1) {
            throw new Error("No active CourseBuilder merchant product matches the Stripe product.");
          }
          const merchantAccount = await step.run("load merchant account", () =>
            db.query.merchantAccount.findFirst({
              where: eq(merchantAccountTable.id, merchantProduct.merchantAccountId),
            }),
          );
          if (!merchantAccount || merchantAccount.status !== 1) {
            throw new Error("The checkout product has no active Stripe merchant account.");
          }

          const user = await step.run("load subscriber", async () => {
            const checkoutUserId = subscriptionInfo.metadata?.userId;
            const checkoutUser = checkoutUserId ? await adapter.getUserById(checkoutUserId) : null;

            if (checkoutUser) return checkoutUser;
            if (!subscriptionInfo.email) {
              throw new Error(
                "Subscription checkout is missing both a user id and customer email.",
              );
            }

            const result = await adapter.findOrCreateUser(
              subscriptionInfo.email,
              subscriptionInfo.name,
            );
            return result.user;
          });

          const organizationContext = await step.run("load subscriber organization", async () => {
            const checkoutOrganizationId = subscriptionInfo.metadata?.organizationId;

            if (checkoutOrganizationId) {
              const organization = await adapter.getOrganization(checkoutOrganizationId);
              if (!organization) {
                throw new Error("Checkout organization was not found.");
              }

              const membership = await adapter.addMemberToOrganization({
                organizationId: organization.id,
                userId: user.id,
                invitedById: user.id,
              });
              if (!membership) {
                throw new Error("Unable to load the subscriber organization membership.");
              }

              return { organization, membership };
            }

            return ensurePersonalOrganization(user);
          });

          await step.run("store merchant checkout session", () =>
            adapter.createMerchantSession({
              merchantAccountId: merchantAccount.id,
              identifier: stripeCheckoutSession.id,
              organizationId: organizationContext.organization.id,
            }),
          );

          const merchantCustomer = await step.run("load merchant customer", async () => {
            const merchantUser = await adapter.getUserById(user.id);
            if (!merchantUser) {
              throw new Error("Unable to reload the subscriber for the Stripe customer.");
            }

            return adapter.findOrCreateMerchantCustomer({
              user: merchantUser,
              identifier: subscriptionInfo.customerIdentifier,
              merchantAccountId: merchantAccount.id,
            });
          });
          if (!merchantCustomer) {
            throw new Error("Unable to persist the Stripe customer.");
          }

          const storedMerchantSubscription = await step.run(
            "load or create merchant subscription",
            async () => {
              const existingMerchantSubscription = await db.query.merchantSubscription.findFirst({
                where: eq(merchantSubscription.identifier, subscriptionInfo.subscriptionIdentifier),
              });
              if (existingMerchantSubscription) return existingMerchantSubscription;

              const createdMerchantSubscription = await adapter.createMerchantSubscription({
                merchantAccountId: merchantAccount.id,
                merchantCustomerId: merchantCustomer.id,
                merchantProductId: merchantProduct.id,
                identifier: subscriptionInfo.subscriptionIdentifier,
              });
              if (!createdMerchantSubscription) {
                throw new Error("Unable to persist the Stripe subscription.");
              }

              return createdMerchantSubscription;
            },
          );

          const localSubscription = await step.run("load or create subscription", async () => {
            const existingSubscription = await db.query.subscription.findFirst({
              where: eq(subscription.merchantSubscriptionId, storedMerchantSubscription.id),
            });
            if (existingSubscription) return existingSubscription;

            const createdSubscription = await adapter.createSubscription({
              merchantSubscriptionId: storedMerchantSubscription.id,
              organizationId: organizationContext.organization.id,
              productId: merchantProduct.productId,
            });
            if (!createdSubscription) {
              throw new Error("Unable to persist the CourseBuilder subscription.");
            }

            return createdSubscription;
          });
          return {
            subscriptionId: localSubscription.id,
            announce: () =>
              step.sendEvent("announce new subscription", {
                name: NEW_SUBSCRIPTION_CREATED_EVENT,
                data: {
                  subscriptionId: localSubscription.id,
                  checkoutSessionId: stripeCheckoutSession.id,
                },
                user,
              }),
          };
        },
        loadSnapshot: (stripeSubscriptionId, snapshotEvent) =>
          loadStripeSubscriptionSnapshot(requireProvider(), stripeSubscriptionId, snapshotEvent),
        reconcile: (snapshot, ownership) => getSubscriptionStore().reconcile(snapshot, ownership),
        waitForDeletedCustomer: (stripeCustomerId, attempt) =>
          waitForDeletionRecord(step, stripeCustomerId, attempt),
      },
    );
  },
);

export const stripeCustomerSubscriptionUpdated = inngest.createFunction(
  {
    id: "egghead-stripe-customer-subscription-updated",
    name: "Egghead Stripe Customer Subscription Updated",
    idempotency: "event.data.stripeEvent.id",
    onFailure: alertOnRetriesExhausted,
    concurrency: {
      limit: 1,
      key: "event.data.stripeEvent.data.object.id",
    },
  },
  [
    { event: STRIPE_CUSTOMER_SUBSCRIPTION_UPDATED_EVENT },
    { event: SUBSCRIPTION_DELETED_EVENT },
    { event: BILLING_SIGNAL_EVENT },
  ],
  async ({ event, step }) =>
    handleSubscriptionBillingEvent(
      event,
      (name, work) => step.run(name, work),
      undefined,
      (stripeCustomerId, attempt) => waitForDeletionRecord(step, stripeCustomerId, attempt),
    ),
);
