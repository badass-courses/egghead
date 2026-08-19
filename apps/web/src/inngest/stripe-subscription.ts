import { NEW_SUBSCRIPTION_CREATED_EVENT } from "@coursebuilder/core/inngest/commerce/event-new-subscription-created";
import { STRIPE_CHECKOUT_SESSION_COMPLETED_EVENT } from "@coursebuilder/core/inngest/stripe/event-checkout-session-completed";
import { STRIPE_CUSTOMER_SUBSCRIPTION_UPDATED_EVENT } from "@coursebuilder/core/inngest/stripe/event-customer-subscription-updated";
import { parseSubscriptionInfoFromCheckoutSession } from "@coursebuilder/core/pricing/stripe-subscription-utils";
import { checkoutSessionCompletedEvent } from "@coursebuilder/core/schemas/stripe/checkout-session-completed";
import { and, eq, isNull } from "drizzle-orm";

import { getStripeProvider, retrieveStripeEventCreatedAt } from "../coursebuilder/stripe-provider";
import { getCourseBuilderAdapter, getEggheadDatabase } from "../db/adapter";
import { assertCommerceWritesAllowed } from "../db/local-docker";
import {
  entitlements,
  merchantCustomer as merchantCustomerTable,
  merchantSubscription,
  subscription,
} from "../db/schema";
import {
  STRIPE_SUBSCRIPTION_SOURCE,
  syncStripeSubscriptionEntitlement,
} from "../subscriptions/access";
import { ensurePersonalOrganization } from "../subscriptions/personal-organization";
import {
  getStripeSubscriptionCurrentPeriodEnd,
  getStripeSubscriptionQuantity,
} from "../subscriptions/stripe";
import {
  mergeTeamSubscriptionFields,
  subscriptionCheckoutQuantitySchema,
  teamSubscriptionFieldsSchema,
} from "../subscriptions/team-contracts";
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

    const merchantProduct = await step.run("load merchant product", () =>
      adapter.getMerchantProduct(subscriptionInfo.productIdentifier),
    );
    if (!merchantProduct) {
      throw new Error("No CourseBuilder merchant product matches the Stripe product.");
    }

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

    const currentStripeSubscription = await step.run(
      "load current Stripe subscription for checkout",
      () =>
        stripeProvider.options.paymentsAdapter.getSubscription(
          subscriptionInfo.subscriptionIdentifier,
        ),
    );
    const currentPeriodEnd = getStripeSubscriptionCurrentPeriodEnd(currentStripeSubscription);
    if (!currentPeriodEnd) {
      throw new Error("Stripe subscription is missing its current period end.");
    }
    const seatCount = subscriptionCheckoutQuantitySchema.parse(
      getStripeSubscriptionQuantity(currentStripeSubscription) ?? subscriptionInfo.quantity,
    );

    await step.run("store subscription seats", () =>
      db
        .update(subscription)
        .set({
          fields: mergeTeamSubscriptionFields(localSubscription.fields, {
            ownerId: user.id,
            seats: seatCount,
          }),
        })
        .where(eq(subscription.id, localSubscription.id)),
    );

    if (seatCount === 1) {
      await step.run("sync initial subscription state", () =>
        syncStripeSubscriptionEntitlement({
          currentPeriodEnd: new Date(currentPeriodEnd * 1000),
          localSubscriptionId: localSubscription.id,
          organizationId: organizationContext.organization.id,
          organizationMembershipId: organizationContext.membership.id,
          productId: merchantProduct.productId,
          status: currentStripeSubscription.status,
          stripeEventCreatedAt: stripeEvent.created,
          stripeEventKind: "checkout",
          stripeSubscriptionId: subscriptionInfo.subscriptionIdentifier,
          userId: user.id,
        }),
      );
    } else {
      // Team subscriptions expose a pool of seats. The owner deliberately claims one
      // from /team instead of checkout assigning a seat implicitly.
      await step.run("sync initial team subscription state", () =>
        db
          .update(subscription)
          .set({ status: currentStripeSubscription.status })
          .where(eq(subscription.id, localSubscription.id)),
      );
    }

    await step.sendEvent("announce new subscription", {
      name: NEW_SUBSCRIPTION_CREATED_EVENT,
      data: {
        subscriptionId: localSubscription.id,
        checkoutSessionId: stripeCheckoutSession.id,
      },
      user,
    });

    return {
      seatCount,
      subscriptionId: localSubscription.id,
      status: currentStripeSubscription.status,
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
  { event: STRIPE_CUSTOMER_SUBSCRIPTION_UPDATED_EVENT },
  async ({ event, step, logger }) => {
    assertCommerceWritesAllowed();

    const stripeEvent = event.data.stripeEvent;
    const stripeSubscriptionId = stripeEvent.data.object.id;
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

    // The published CourseBuilder event schema strips fields needed for lifecycle updates.
    // Reloading Stripe's current state also makes delayed webhook delivery converge safely.
    const stripeSubscription = await step.run("load current Stripe subscription", () =>
      stripeProvider.options.paymentsAdapter.getSubscription(stripeSubscriptionId),
    );

    const stored = await step.run("load stored subscription", () =>
      db.query.merchantSubscription.findFirst({
        where: eq(merchantSubscription.identifier, stripeSubscriptionId),
        with: { subscription: true },
      }),
    );
    const localSubscription = stored?.subscription;

    const organizationId = localSubscription?.organizationId;
    const productId = localSubscription?.productId;

    if (!stored || !localSubscription || !organizationId || !productId) {
      logger.warn("Ignoring Stripe subscription update", {
        reason: "local_subscription_not_found_or_incomplete",
        stripeEventId: stripeEvent.id,
        stripeSubscriptionId,
        localSubscriptionId: localSubscription?.id ?? null,
        organizationId: organizationId ?? null,
        productId: productId ?? null,
      });
      throw new Error(`Local subscription ${stripeSubscriptionId} is not ready for update.`);
    }

    const currentPeriodEnd = getStripeSubscriptionCurrentPeriodEnd(stripeSubscription);
    const seatCount = subscriptionCheckoutQuantitySchema.safeParse(
      getStripeSubscriptionQuantity(stripeSubscription),
    );
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

    if (!currentPeriodEnd || !seatCount.success || !ownerId) {
      logger.warn("Ignoring incomplete Stripe subscription update", {
        reason: "subscription_period_seats_or_owner_missing",
        stripeEventId: stripeEvent.id,
        stripeSubscriptionId,
        subscriptionId: localSubscription.id,
        hasCurrentPeriodEnd: Boolean(currentPeriodEnd),
        hasOwner: Boolean(ownerId),
        hasSeatCount: seatCount.success,
      });
      return { ignored: true, subscriptionId: localSubscription.id };
    }

    await step.run("sync subscription seat count", () =>
      db
        .update(subscription)
        .set({
          fields: mergeTeamSubscriptionFields(localSubscription.fields, {
            ownerId,
            seats: seatCount.data,
          }),
        })
        .where(eq(subscription.id, localSubscription.id)),
    );

    const subscriptionEntitlements = await step.run("load subscription entitlements", () =>
      db.query.entitlements.findMany({
        where: and(
          eq(entitlements.sourceId, localSubscription.id),
          eq(entitlements.sourceType, STRIPE_SUBSCRIPTION_SOURCE),
          isNull(entitlements.deletedAt),
        ),
      }),
    );
    const completeEntitlements = subscriptionEntitlements.filter(
      (
        entitlement,
      ): entitlement is typeof entitlement & {
        organizationMembershipId: string;
        userId: string;
      } => Boolean(entitlement.organizationMembershipId && entitlement.userId),
    );

    if (completeEntitlements.length === 0) {
      await step.run("sync unclaimed team subscription state", () =>
        db
          .update(subscription)
          .set({ status: stripeSubscription.status })
          .where(eq(subscription.id, localSubscription.id)),
      );
    } else {
      await step.run("sync assigned subscription seats", () =>
        Promise.all(
          completeEntitlements.map((entitlement) =>
            syncStripeSubscriptionEntitlement({
              currentPeriodEnd: new Date(currentPeriodEnd * 1000),
              entitlementId: entitlement.id,
              localSubscriptionId: localSubscription.id,
              organizationId,
              organizationMembershipId: entitlement.organizationMembershipId,
              productId,
              status: stripeSubscription.status,
              stripeEventCreatedAt,
              stripeEventKind: "subscription_update",
              stripeSubscriptionId,
              userId: entitlement.userId,
            }),
          ),
        ),
      );
    }

    return {
      assignedSeats: completeEntitlements.length,
      seatCount: seatCount.data,
      subscriptionId: localSubscription.id,
      status: stripeSubscription.status,
    };
  },
);
