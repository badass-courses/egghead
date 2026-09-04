import { NEW_SUBSCRIPTION_CREATED_EVENT } from "@coursebuilder/core/inngest/commerce/event-new-subscription-created";
import { STRIPE_CHECKOUT_SESSION_COMPLETED_EVENT } from "@coursebuilder/core/inngest/stripe/event-checkout-session-completed";
import { STRIPE_CUSTOMER_SUBSCRIPTION_UPDATED_EVENT } from "@coursebuilder/core/inngest/stripe/event-customer-subscription-updated";
import { parseSubscriptionInfoFromCheckoutSession } from "@coursebuilder/core/pricing/stripe-subscription-utils";
import { checkoutSessionCompletedEvent } from "@coursebuilder/core/schemas/stripe/checkout-session-completed";
import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  getStripeProvider,
  retrieveStripeEventCreatedAt,
  retrieveStripeSubscriptionForLifecycle,
  stripeMembershipCatalogProvider,
} from "../coursebuilder/stripe-provider";
import { getCourseBuilderAdapter, getEggheadDatabase } from "../db/adapter";
import { assertCommerceWritesAllowed } from "../db/local-docker";
import {
  merchantCustomer as merchantCustomerTable,
  merchantSubscription,
  subscription,
} from "../db/schema";
import { syncStripeSubscription } from "../subscriptions/access";
import { getValidatedMembershipCheckoutMapping } from "../subscriptions/catalog";
import { ensurePersonalOrganization } from "../subscriptions/personal-organization";
import { teamSubscriptionFieldsSchema } from "../subscriptions/team-contracts";
import {
  inngest,
  STRIPE_CUSTOMER_SUBSCRIPTION_DELETED_EVENT,
  STRIPE_INVOICE_PAID_EVENT,
} from "./client";

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
    assertCommerceWritesAllowed();

    const stripeEvent = checkoutSessionCompletedEvent.parse(event.data.stripeEvent);
    const stripeCheckoutSession = stripeEvent.data.object;
    const stripeProvider = getStripeProvider();
    const adapter = getCourseBuilderAdapter();
    const db = getEggheadDatabase();

    if (!stripeProvider) {
      throw new Error("Stripe is not configured.");
    }

    const merchantAccount = await step.run("load merchant account", () =>
      adapter.getMerchantAccount({ provider: "stripe" }),
    );

    if (!merchantAccount) {
      throw new Error("Stripe merchant account is not configured in CourseBuilder.");
    }

    const checkoutSession = await step.run("load expanded checkout session", () =>
      stripeProvider.options.paymentsAdapter.getCheckoutSession(stripeCheckoutSession.id),
    );
    const subscriptionInfo = await step.run("parse subscription checkout", () =>
      parseSubscriptionInfoFromCheckoutSession(checkoutSession),
    );
    const { metadata } = z
      .object({ metadata: z.object({ productId: z.string().min(1) }) })
      .parse(checkoutSession);
    const checkoutMapping = await step.run("validate exact checkout membership mapping", () =>
      getValidatedMembershipCheckoutMapping(
        {
          productId: metadata.productId,
          stripeProductId: subscriptionInfo.productIdentifier,
          stripePriceId: subscriptionInfo.priceIdentifier,
          merchantAccountId: merchantAccount.id,
          quantity: subscriptionInfo.quantity,
        },
        stripeMembershipCatalogProvider(stripeProvider),
      ),
    );

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

    const organizationContext = z
      .object({ organization: z.object({ id: z.string().min(1) }) })
      .parse(
        await step.run("load subscriber organization", async () => {
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
        }),
      );

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
        if (existingMerchantSubscription) {
          if (
            existingMerchantSubscription.merchantAccountId !== checkoutMapping.merchantAccountId ||
            existingMerchantSubscription.merchantProductId !== checkoutMapping.merchantProductId
          ) {
            throw new Error("Existing merchant subscription conflicts with the checkout mapping.");
          }
          return existingMerchantSubscription;
        }

        const createdMerchantSubscription = await adapter.createMerchantSubscription({
          merchantAccountId: merchantAccount.id,
          merchantCustomerId: merchantCustomer.id,
          merchantProductId: checkoutMapping.merchantProductId,
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
      if (existingSubscription) {
        if (existingSubscription.productId !== checkoutMapping.productId) {
          throw new Error("Existing subscription conflicts with the checkout product.");
        }
        return existingSubscription;
      }

      const createdSubscription = await adapter.createSubscription({
        merchantSubscriptionId: storedMerchantSubscription.id,
        organizationId: organizationContext.organization.id,
        productId: checkoutMapping.productId,
      });
      if (!createdSubscription) {
        throw new Error("Unable to persist the CourseBuilder subscription.");
      }

      return createdSubscription;
    });

    const reconciled = await step.run("reconcile subscription and all grants", () =>
      syncStripeSubscription({
        localSubscriptionId: localSubscription.id,
        stripeSubscriptionId: subscriptionInfo.subscriptionIdentifier,
        ownerId: user.id,
        event: { id: stripeEvent.id, createdAt: stripeEvent.created, kind: "checkout" },
        retrieveCurrentSubscription: () =>
          retrieveStripeSubscriptionForLifecycle(
            stripeProvider,
            subscriptionInfo.subscriptionIdentifier,
          ),
      }),
    );

    await step.sendEvent("announce new subscription", {
      name: NEW_SUBSCRIPTION_CREATED_EVENT,
      data: {
        subscriptionId: localSubscription.id,
        checkoutSessionId: stripeCheckoutSession.id,
      },
      user,
    });

    return {
      reconciliation: reconciled,
      subscriptionId: localSubscription.id,
    };
  },
);

export const stripeCustomerSubscriptionLifecycle = inngest.createFunction(
  {
    id: "egghead-stripe-customer-subscription-updated",
    name: "Egghead Stripe Customer Subscription Lifecycle",
    idempotency: "event.data.stripeEvent.id",
    concurrency: {
      limit: 1,
      key: "event.name == 'stripe/invoice-paid' ? event.data.stripeEvent.data.object.subscription : event.data.stripeEvent.data.object.id",
    },
  },
  [
    { event: STRIPE_CUSTOMER_SUBSCRIPTION_UPDATED_EVENT },
    { event: STRIPE_CUSTOMER_SUBSCRIPTION_DELETED_EVENT },
    { event: STRIPE_INVOICE_PAID_EVENT },
  ],
  async ({ event, step, logger }) => {
    assertCommerceWritesAllowed();

    const stripeEvent = event.data.stripeEvent;
    const stripeSubscriptionId =
      event.name === STRIPE_INVOICE_PAID_EVENT
        ? event.data.stripeEvent.data.object.subscription
        : event.data.stripeEvent.data.object.id;
    if (!stripeSubscriptionId) throw new Error("Lifecycle event has no associated subscription.");
    const stripeProvider = getStripeProvider();

    const db = getEggheadDatabase();

    if (!stripeProvider) {
      throw new Error("Stripe is not configured.");
    }
    // CourseBuilder's published update-event schema strips Stripe's creation timestamp.
    // Reload the source event so entitlement ordering remains based on Stripe event time.
    const stripeEventCreatedAt = await step.run("load Stripe event timestamp", () =>
      retrieveStripeEventCreatedAt(stripeProvider, stripeEvent.id),
    );

    // The current provider snapshot is retrieved inside the shared subscription-row
    // transaction below, not in a separately cached step that can replay stale state.

    const stored = await step.run("load stored subscription", () =>
      db.query.merchantSubscription.findFirst({
        where: eq(merchantSubscription.identifier, stripeSubscriptionId),
        with: { subscription: true },
      }),
    );
    const localSubscription = stored?.subscription;

    if (!stored || !localSubscription) {
      logger.warn("Ignoring Stripe subscription update", {
        reason: "local_subscription_not_found_or_incomplete",
        stripeEventId: stripeEvent.id,
        stripeSubscriptionId,
        localSubscriptionId: localSubscription?.id ?? null,
      });
      throw new Error(`Local subscription ${stripeSubscriptionId} is not ready for update.`);
    }

    const storedTeamFields = teamSubscriptionFieldsSchema.safeParse(localSubscription.fields);
    const subscriptionOwnerCustomer = storedTeamFields.success
      ? null
      : await step.run("load subscription owner", () =>
          db.query.merchantCustomer.findFirst({
            where: eq(merchantCustomerTable.id, stored.merchantCustomerId),
          }),
        );
    const ownerId = storedTeamFields.success
      ? storedTeamFields.data.ownerId
      : subscriptionOwnerCustomer?.userId;

    if (!ownerId) throw new Error("Subscription owner is missing; reconciliation cannot proceed.");

    const reconciled = await step.run("reconcile subscription and all grants", () =>
      syncStripeSubscription({
        localSubscriptionId: localSubscription.id,
        stripeSubscriptionId,
        ownerId,
        event: {
          id: stripeEvent.id,
          createdAt: stripeEventCreatedAt,
          kind:
            event.name === STRIPE_CUSTOMER_SUBSCRIPTION_DELETED_EVENT
              ? "subscription_deleted"
              : event.name === STRIPE_INVOICE_PAID_EVENT
                ? "invoice_paid"
                : "subscription_update",
        },
        retrieveCurrentSubscription: () =>
          retrieveStripeSubscriptionForLifecycle(stripeProvider, stripeSubscriptionId),
      }),
    );

    return {
      reconciliation: reconciled,
      subscriptionId: localSubscription.id,
    };
  },
);
