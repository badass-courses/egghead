import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { getCourseBuilderAdapter, getEggheadDatabase } from "../db/adapter";
import { entitlements, merchantCustomer, merchantSubscription, subscription } from "../db/schema";
import {
  CURRENT_SUBSCRIPTION_STATUSES,
  EGGHEAD_SUBSCRIPTION_ENTITLEMENT,
  STRIPE_SUBSCRIPTION_SOURCE,
} from "./access";
import { isTeamSubscription, teamSubscriptionFieldsSchema } from "./team-contracts";

/**
 * The subscription whose billing this user manages. A current row (active,
 * past_due, trialing) wins over any newer non-current one, so an old canceled
 * attempt cannot hide a live subscription; otherwise the newest row is returned
 * so a lapsed owner can still open billing.
 */
export async function getBillingSubscriptionForUser(userId: string) {
  const [owned] = await getEggheadDatabase()
    .select({ subscription })
    .from(subscription)
    .innerJoin(
      merchantSubscription,
      eq(merchantSubscription.id, subscription.merchantSubscriptionId),
    )
    .innerJoin(merchantCustomer, eq(merchantCustomer.id, merchantSubscription.merchantCustomerId))
    .where(eq(merchantCustomer.userId, userId))
    .orderBy(
      sql`case when ${inArray(subscription.status, CURRENT_SUBSCRIPTION_STATUSES)} then 0 else 1 end`,
      desc(subscription.createdAt),
    )
    .limit(1);
  return owned?.subscription ?? null;
}

/**
 * A current team subscription this user owns, found through their organization
 * memberships. Membership alone never makes someone a beneficiary: a teammate in
 * a buyer's organization does not get the buyer's individual subscription, and a
 * member of a paused or suspended team has no grant and so no subscription.
 * Beneficiaries come from live grants (the seat-grant branch below).
 */
async function getOwnedTeamThroughMembership(userId: string) {
  const db = getEggheadDatabase();
  const memberships = await getCourseBuilderAdapter().getMembershipsForUser(userId);
  const organizationIds = memberships
    .map((membership) => membership.organizationId)
    .filter((organizationId): organizationId is string => Boolean(organizationId));
  if (organizationIds.length === 0) return null;

  const currentSubscriptions = await db.query.subscription.findMany({
    where: and(
      inArray(subscription.organizationId, organizationIds),
      inArray(subscription.status, CURRENT_SUBSCRIPTION_STATUSES),
    ),
    limit: 100,
  });
  return (
    currentSubscriptions.find((candidate) => {
      const fields = teamSubscriptionFieldsSchema.safeParse(candidate.fields);
      return (
        isTeamSubscription(candidate.fields) && fields.success && fields.data.ownerId === userId
      );
    }) ?? null
  );
}

/**
 * A current subscription this user benefits from: owned through the Stripe
 * customer, a current team the user owns in one of their organizations, or held
 * as a live seat grant. Organization membership alone grants nothing. A seat grant with a NULL `expiresAt` has no expiry and counts.
 *
 * Callers checked: `app/pricing/page.tsx` (current plan display),
 * `app/thanks/subscription/page.tsx` (post-checkout state) and
 * `subscriptions/checkout.ts` (refuses a second checkout as "existing").
 */
export async function getCurrentSubscriptionForUser(userId: string) {
  const db = getEggheadDatabase();
  const [owned] = await db
    .select({ subscription })
    .from(subscription)
    .innerJoin(
      merchantSubscription,
      eq(merchantSubscription.id, subscription.merchantSubscriptionId),
    )
    .innerJoin(merchantCustomer, eq(merchantCustomer.id, merchantSubscription.merchantCustomerId))
    .where(
      and(
        eq(merchantCustomer.userId, userId),
        inArray(subscription.status, CURRENT_SUBSCRIPTION_STATUSES),
      ),
    )
    .orderBy(desc(subscription.createdAt))
    .limit(1);
  if (owned) return owned.subscription;
  const ownedTeam = await getOwnedTeamThroughMembership(userId);
  if (ownedTeam) return ownedTeam;
  const [assigned] = await db
    .select({ subscription })
    .from(entitlements)
    .innerJoin(subscription, eq(subscription.id, entitlements.sourceId))
    .where(
      and(
        eq(entitlements.sourceType, STRIPE_SUBSCRIPTION_SOURCE),
        eq(entitlements.userId, userId),
        isNull(entitlements.deletedAt),
        // NULL expiry means no expiry, but only for subscription seat grants.
        or(
          gt(entitlements.expiresAt, new Date()),
          and(
            isNull(entitlements.expiresAt),
            eq(entitlements.entitlementType, EGGHEAD_SUBSCRIPTION_ENTITLEMENT),
          ),
        ),
        inArray(subscription.status, CURRENT_SUBSCRIPTION_STATUSES),
      ),
    )
    .orderBy(desc(subscription.createdAt))
    .limit(1);
  return assigned?.subscription ?? null;
}
