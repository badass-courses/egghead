import { isDeepStrictEqual } from "node:util";
import {
  buildExpectedProjection,
  isEggheadRailsApplication,
  railsTimestampToIso,
  type CbEntitlement,
  type ExpectedEntitlement,
  type IdentityOutcome,
  type RailsPurchase,
} from "./rails-access-delta";
import { subjectProjectionInput, verifySubject, type SubjectEnvelope } from "./cold-subject";

export interface SubjectClaim {
  readonly claimId: string;
  readonly userId: string;
  readonly railsUserId: string;
}
export type PendingReason =
  | "missing_subject_identity"
  | "subscription_current_law_required"
  | "team_current_seat_required"
  | "backing_current_law_required"
  | "special_role_review_required"
  | "basic_role_review_required"
  | "purchase_reconciliation_required"
  | "restricted_purchase_review_required"
  | "current_overrides_unavailable"
  | "existing_row_conflict";
export interface CurrentSubjectState {
  /** Must be an existing user and a persisted unique, proved subject claim. */
  readonly claim: SubjectClaim;
  readonly userExists: boolean;
  readonly disposition: "eligible" | "banned" | "quarantined" | "erased" | "tombstoned";
  /** Current authoritative ban/refund/dispute/revocation overlay, NOT an archive assertion. */
  readonly overridesComplete: boolean;
  readonly deniedPurchaseIds: readonly string[];
}

/**
 * Transaction capability, permanently scoped to ONE persisted claim/user. Implementations must
 * lock/check claim + current overrides, SELECT entitlements WHERE userId = claim.userId, and
 * INSERT ... ON CONFLICT DO NOTHING (never upsert). A conflicting global id returns conflict;
 * it must not expose/read another user's row. No user, membership, org, update or revoke API.
 * Roll back on callback failure. Serialize with current ban/erasure/commerce overlay writes.
 */
export interface ClaimedUserTransaction {
  readCurrentState(): Promise<CurrentSubjectState>;
  readEntitlements(): Promise<readonly CbEntitlement[]>;
  insertGrantIfAbsent(row: ExpectedEntitlement): Promise<"inserted" | "conflict">;
}
export interface ClaimedUserGrantStore {
  withClaimedUser<T>(
    claim: SubjectClaim,
    work: (transaction: ClaimedUserTransaction) => Promise<T>,
  ): Promise<T>;
}
export interface RecoveryResult {
  readonly status: "complete" | "pending_reconciliation" | "blocked";
  readonly changed: number;
  readonly reasons: readonly string[];
}

function sameGrant(row: CbEntitlement, expected: ExpectedEntitlement) {
  return (
    row.deletedAt === null &&
    row.userId === expected.userId &&
    row.organizationId === null &&
    row.organizationMembershipId === null &&
    row.sourceType === expected.sourceType &&
    row.sourceId === expected.sourceId &&
    row.entitlementType === expected.entitlementType &&
    row.expiresAt === expected.expiresAt &&
    isDeepStrictEqual(row.metadata, expected.metadata)
  );
}
function purchaseEligibility(
  purchase: RailsPurchase,
  now: number,
): "allow" | "deny" | PendingReason {
  if (!isEggheadRailsApplication(purchase.railsApplicationId)) return "deny";
  // Rails-viewable refunds are NOT proof of current paid access. Do not inherit batch parity law.
  if (purchase.purchaseState !== "paid") return "purchase_reconciliation_required";
  if (purchase.sellableType !== "Playlist" && purchase.sellableType !== "Resource::Membership") {
    return "purchase_reconciliation_required";
  }
  if (!purchase.sellableId) return "purchase_reconciliation_required";
  if (purchase.bulk || purchase.restrictedToCountry?.trim())
    return "restricted_purchase_review_required";
  if (purchase.expiresAt !== null) {
    const iso = railsTimestampToIso(purchase.expiresAt);
    if (!iso) return "purchase_reconciliation_required";
    const boundary = Date.parse(iso);
    if (boundary <= now) return "deny";
    // The shared builder maps post-2038 expiries to NULL. Never turn a finite grant permanent.
    if (boundary > Date.UTC(2038, 0, 18, 23, 59, 59)) return "purchase_reconciliation_required";
  }
  return "allow";
}

/**
 * Slice C calls this AFTER proof/unique claim. No auth or DB adapter is installed by this slice.
 * State path: verified -> blocked | pending | projecting -> complete/pending. A thrown store
 * failure rolls back and remains retryable to the caller; no false completion is persisted here.
 */
export async function projectClaimedSubject(input: {
  record: SubjectEnvelope;
  claim: SubjectClaim;
  store: ClaimedUserGrantStore;
  now: Date;
}): Promise<RecoveryResult> {
  const record = verifySubject(input.record);
  if (!Number.isFinite(input.now.getTime())) throw new Error("invalid current clock");
  const { claim } = input;
  if (!claim.claimId || !claim.userId || claim.railsUserId !== record.subject.railsUserId) {
    throw new Error("subject claim mismatch");
  }
  return input.store.withClaimedUser(claim, async (transaction) => {
    const current = await transaction.readCurrentState();
    if (!current.userExists || !isDeepStrictEqual(current.claim, claim))
      throw new Error("unproved or missing user claim");
    const archivedBan = record.evidence.users.some((user) => user.isBanned);
    if (
      current.disposition !== "eligible" ||
      record.subject.disposition !== "eligible" ||
      archivedBan
    ) {
      return { status: "blocked", changed: 0, reasons: ["subject_blocked"] };
    }
    // A claim represents validated proof, including any SAML restriction. Slice C owns that gate.
    if (!current.overridesComplete) {
      return {
        status: "pending_reconciliation",
        changed: 0,
        reasons: ["current_overrides_unavailable"],
      };
    }
    if (record.evidence.users.length !== 1 && record.result !== "empty") {
      return {
        status: "pending_reconciliation",
        changed: 0,
        reasons: ["missing_subject_identity"],
      };
    }
    const reasons = new Set<PendingReason>();
    if (record.evidence.subscriptions.length) {
      reasons.add("subscription_current_law_required");
      if (
        record.evidence.subscriptions.some(
          (sub) => sub.quantity > 1 || sub.members.some((member) => member.hasOwnerRole),
        )
      ) {
        reasons.add("team_current_seat_required");
      }
    }
    if (record.evidence.backingGrants.length) reasons.add("backing_current_law_required");
    if (record.evidence.basicGrants.length) reasons.add("basic_role_review_required");
    if (record.evidence.roleGrants.length) {
      reasons.add("special_role_review_required");
    }
    const purchases = record.evidence.purchases.filter((purchase) => {
      if (current.deniedPurchaseIds.includes(purchase.railsSellablePurchaseId)) return false;
      const decision = purchaseEligibility(purchase, input.now.getTime());
      if (decision === "allow") return true;
      if (decision !== "deny") reasons.add(decision);
      return false;
    });
    const identities = new Map<string, IdentityOutcome>([
      [claim.railsUserId, { kind: "linked", userId: claim.userId }],
    ]);
    const expected = buildExpectedProjection(subjectProjectionInput(record, purchases), identities);
    if (expected.organizations.size || expected.memberships.size)
      throw new Error("shared projection forbidden");
    const existing = await transaction.readEntitlements();
    if (existing.some((row) => row.userId !== claim.userId))
      throw new Error("store crossed user read boundary");
    const byId = new Map(existing.map((row) => [row.id, row]));
    let changed = 0;
    const inserted = new Set<string>();
    // One connection/transaction: serialize grants rather than fanning out DB writes.
    await [...expected.entitlements.values()].reduce(async (previous, row) => {
      await previous;
      if (row.userId !== claim.userId || row.organizationId || row.organizationMembershipId) {
        throw new Error("store crossed user grant boundary");
      }
      const stored = byId.get(row.id);
      if (stored) {
        // Never restore a tombstoned/quarantined/native row, extend, or overwrite newer commerce.
        if (!sameGrant(stored, row)) reasons.add("existing_row_conflict");
        return;
      }
      if ((await transaction.insertGrantIfAbsent(row)) === "inserted") {
        changed++;
        inserted.add(row.id);
      } else reasons.add("existing_row_conflict");
    }, Promise.resolve());
    // Readback is part of the transaction; failure must not be recorded as reactivated.
    const readback = await transaction.readEntitlements();
    if (readback.some((row) => row.userId !== claim.userId))
      throw new Error("store crossed readback boundary");
    if (
      changed &&
      [...expected.entitlements.values()].some(
        (row) =>
          inserted.has(row.id) &&
          !readback.some((stored) => stored.id === row.id && sameGrant(stored, row)),
      )
    ) {
      throw new Error("projection readback mismatch");
    }
    return {
      status: reasons.size ? "pending_reconciliation" : "complete",
      changed,
      reasons: [...reasons].toSorted(),
    };
  });
}
