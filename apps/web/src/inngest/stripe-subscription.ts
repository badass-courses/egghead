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
import { assertMembershipWritesAllowed } from "../subscriptions/write-policy";
import { ensurePersonalOrganization } from "../subscriptions/personal-organization";
import { loadStripeSubscriptionSnapshot } from "../subscriptions/stripe-billing";
import { getSubscriptionStore } from "../subscriptions/store";
import { SUBSCRIPTION_DELETED_EVENT } from "../subscriptions/webhook-contract";
import { inngest } from "./client";

export const stripeSubscriptionCheckoutSessionComplete = inngest.createFunction(
  {
    id: "stripe-subscription-checkout-session-completed",
    name: "Stripe Subscription Checkout Session Completed",
    idempotency: "event.data.stripeEvent.data.object.id",
  },
  {
    event: STRIPE_CHECKOUT_SESSION_COMPLETED_EVENT,
    if: "event.data.stripeEvent.data.object.mode == 'subscription'",
  },
  async ({ event, step }) => {
    assertMembershipWritesAllowed();

    const stripeEvent = checkoutSessionCompletedEvent.parse(event.data.stripeEvent);
    const stripeCheckoutSession = stripeEvent.data.object;
    const stripeProvider = getStripeProvider();
    const adapter = getCourseBuilderAdapter();
    const db = getEggheadDatabase();

    if (!stripeProvider) {
      throw new Error("Stripe is not configured.");
    }

    const checkoutSession = await step.run("load expanded checkout session", () =>
      stripeProvider.options.paymentsAdapter.getCheckoutSession(stripeCheckoutSession.id),
    );
    const subscriptionInfo = await step.run("parse subscription checkout", () =>
      parseSubscriptionInfoFromCheckoutSession(checkoutSession),
    );
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
        throw new Error("Subscription checkout is missing both a user id and customer email.");
      }

      const result = await adapter.findOrCreateUser(subscriptionInfo.email, subscriptionInfo.name);
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

    const snapshot = await step.run("load current subscription billing", () =>
      loadStripeSubscriptionSnapshot(stripeProvider, subscriptionInfo.subscriptionIdentifier, {
        id: stripeEvent.id,
        createdAt: stripeEvent.created,
        kind: "checkout",
      }),
    );
    await step.run("reconcile initial subscription", async () => {
      const result = await getSubscriptionStore().reconcile(snapshot);
      if (result.status === "not-ready")
        throw new Error("Subscription is not ready for checkout reconciliation");
      return result;
    });

    await step.sendEvent("announce new subscription", {
      name: NEW_SUBSCRIPTION_CREATED_EVENT,
      data: {
        subscriptionId: localSubscription.id,
        checkoutSessionId: stripeCheckoutSession.id,
      },
      user,
    });

    return {
      seatCount: snapshot.seats,
      subscriptionId: localSubscription.id,
      status: snapshot.status,
    };
  },
);

export const stripeCustomerSubscriptionUpdated = inngest.createFunction(
  {
    id: "egghead-stripe-customer-subscription-updated",
    name: "Egghead Stripe Customer Subscription Updated",
    idempotency: "event.data.stripeEvent.id",
    concurrency: {
      limit: 1,
      key: "event.data.stripeEvent.data.object.id",
    },
  },
  [{ event: STRIPE_CUSTOMER_SUBSCRIPTION_UPDATED_EVENT }, { event: SUBSCRIPTION_DELETED_EVENT }],
  async ({ event, step }) => {
    assertMembershipWritesAllowed();
    const stripeEvent = event.data.stripeEvent;
    const provider = getStripeProvider();
    if (!provider) throw new Error("Stripe is not configured");
    const snapshot = await step.run("load current subscription billing", () =>
      loadStripeSubscriptionSnapshot(provider, stripeEvent.data.object.id, {
        id: stripeEvent.id,
        kind:
          event.name === SUBSCRIPTION_DELETED_EVENT
            ? "subscription_deleted"
            : "subscription_update",
      }),
    );
    return step.run("reconcile subscription", async () => {
      const result = await getSubscriptionStore().reconcile(snapshot);
      if (result.status === "not-ready")
        throw new Error("Local subscription is not ready for reconciliation");
      return result;
    });
  },
);
