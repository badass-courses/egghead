import {
  membershipGrants,
  railsTimestampToIso,
  type CbEntitlement,
  type CbSnapshot,
  type RailsAccessExport,
} from "./rails-access-delta";

const SOURCE = "rails_account_subscription";
const BROAD_TYPES = new Set([
  "egghead_all_access_subscription",
  "egghead_lifetime_access",
  "egghead_staff_special_access",
  "egghead_membership_access",
  "egghead_basic_legacy_access",
]);
const REASONS = [
  "status_past_due",
  "status_trialing",
  "status_unpaid",
  "missing_boundary",
  "boundary_passed",
  "no_seat",
  "subscription_missing",
  "status_other",
] as const;
type Reason = (typeof REASONS)[number];

function reachedRows(snapshot: CbSnapshot): Map<string, Set<CbEntitlement>> {
  const membersByOrg = new Map<string, Set<string>>();
  for (const member of snapshot.memberships) {
    if (!member.organizationId || !membershipGrants(member)) continue;
    const users = membersByOrg.get(member.organizationId) ?? new Set<string>();
    users.add(member.userId);
    membersByOrg.set(member.organizationId, users);
  }
  const byUser = new Map<string, Set<CbEntitlement>>();
  for (const row of snapshot.entitlements) {
    if (row.deletedAt !== null || !BROAD_TYPES.has(row.entitlementType)) continue;
    const users = new Set(row.organizationId ? membersByOrg.get(row.organizationId) : []);
    if (row.userId) users.add(row.userId);
    for (const userId of users) {
      const rows = byUser.get(userId) ?? new Set<CbEntitlement>();
      rows.add(row);
      byUser.set(userId, rows);
    }
  }
  return byUser;
}

function bucket(): { holders: number; sampleRailsSubscriptionIds: string[] } {
  return { holders: 0, sampleRailsSubscriptionIds: [] };
}

/**
 * Compare current holders under the old source bypass with the simulated strict
 * projection. Count people, not org/seat rows. Another broad grant prevents a
 * loss; a course-only grant does not replace subscription-wide access.
 * Each holder gets one primary reason in REASONS priority order. Samples are
 * Rails subscription ids only; no user ids, email, or provider identifiers.
 */
export function subscriptionBoundaryLoss(
  railsExport: RailsAccessExport,
  before: CbSnapshot,
  after: CbSnapshot,
  nowMs: number,
) {
  const subscriptions = new Map(
    railsExport.subscriptions.map((sub) => [sub.railsAccountSubscriptionId, sub]),
  );
  const byReason = {
    status_past_due: bucket(),
    status_trialing: bucket(),
    status_unpaid: bucket(),
    missing_boundary: bucket(),
    boundary_passed: bucket(),
    no_seat: bucket(),
    subscription_missing: bucket(),
    status_other: bucket(),
  } satisfies Record<Reason, ReturnType<typeof bucket>>;
  const beforeByUser = reachedRows(before);
  const afterByUser = reachedRows(after);
  let currentSubscriptionHolders = 0;
  let losingHolders = 0;
  for (const [userId, rows] of beforeByUser) {
    const current = [...rows].filter((row) => row.sourceType === SOURCE);
    if (!current.length) continue;
    currentSubscriptionHolders++;
    const keepsBroadAccess = [...(afterByUser.get(userId) ?? [])].some(
      (row) => row.expiresAt === null || Date.parse(row.expiresAt) > nowMs,
    );
    if (keepsBroadAccess) continue;
    const reasons = new Map<Reason, Set<string>>();
    for (const row of current) {
      const sub = subscriptions.get(row.sourceId);
      let reason: Reason;
      if (!sub) reason = "subscription_missing";
      else if (sub.status === "past_due") reason = "status_past_due";
      else if (sub.status === "trialing") reason = "status_trialing";
      else if (sub.status === "unpaid") reason = "status_unpaid";
      else if (sub.status !== "active") reason = "status_other";
      else {
        const boundary = railsTimestampToIso(sub.currentPeriodEnd);
        if (boundary === null) reason = "missing_boundary";
        else if (Date.parse(boundary) <= nowMs) reason = "boundary_passed";
        else reason = "no_seat";
      }
      const ids = reasons.get(reason) ?? new Set<string>();
      ids.add(row.sourceId);
      reasons.set(reason, ids);
    }
    const primary = REASONS.find((reason) => reasons.has(reason));
    if (!primary) continue;
    losingHolders++;
    const counts = byReason[primary];
    counts.holders++;
    counts.sampleRailsSubscriptionIds = [
      ...new Set([...counts.sampleRailsSubscriptionIds, ...(reasons.get(primary) ?? [])]),
    ]
      .toSorted()
      .slice(0, 5);
  }
  return {
    currentSubscriptionHolders,
    losingHolders,
    retainedHolders: currentSubscriptionHolders - losingHolders,
    reasonPriority: REASONS,
    byReason,
  };
}
