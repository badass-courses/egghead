import { createHash } from "node:crypto";

// Orchestration shared by the access-delta CLI and its tests: read CourseBuilder,
// compute the plan, simulate it, shadow-compare before and after, build the
// receipt, and (on apply) execute and verify.

import {
  ACCESS_DELTA_LAW,
  computeDeltaPlan,
  BACKING_SOURCE_TYPES,
  DEFAULT_BARE_PRO_ACTIVE_DAYS,
  DEFAULT_LEGACY_STALE_DAYS,
  DELTA_OP_KINDS,
  exportProEquivalent,
  emailKeyFor,
  IDENTITY_OP_KINDS,
  identityConflicts,
  resolveIdentities,
  simulateApply,
  BARE_PRO_ACTIVE_SOURCE_TYPE,
  type BackingSourceType,
  type CbSnapshot,
  type GatedSourceType,
  type DeltaOp,
  type DeltaOpKind,
  type DeltaPlan,
  type RailsAccessExport,
  type RailsBackingGrant,
  type RailsProHolder,
  type SeatFlagRuling,
  railsTimestampToIso,
} from "../apps/web/src/access/rails-access-delta";
import {
  planSha256,
  type ApplyCursor,
  type GateInputs,
} from "../apps/web/src/access/rails-access-delta-plan";
import {
  applyDeltaOps,
  type BatchTiming,
  DEFAULT_READ_OPTIONS,
  readCbSnapshot,
  type EggheadDatabase,
  type SnapshotReadOptions,
} from "../apps/web/src/access/rails-access-delta-store";
import {
  compareShadow,
  type ShadowResult,
  type UserShadow,
} from "../apps/web/src/access/rails-access-shadow";

export const RECEIPT_FORMAT = "egghead-access-delta-receipt/v1";
const SAMPLE_SIZE = 20;

/**
 * `full` plans everything. `identity` plans only email updates and links, so a
 * later full run sees the moved emails (an X->Y move freeing X for a new user).
 */
export type DeltaPass = "full" | "identity";

export interface AnalyzeOptions {
  readonly pass?: DeltaPass;
  readonly seatFlagRulings?: ReadonlyMap<string, SeatFlagRuling>;
  /** Default 45 days. */
  readonly legacyStaleDays?: number;
  /** Default 365 days. */
  readonly bareProActiveDays?: number;
}

/** Default for `--max-identity-ops`: email updates plus links in one plan. */
export const DEFAULT_MAX_IDENTITY_OPS = 50;

export interface EmailMoveCollisions {
  /** Two ops (email updates or creates) writing the same email key. */
  readonly sameTarget: number;
  /** An email update or create onto an email another CourseBuilder user holds now. */
  readonly targetHeld: number;
  /** Two links onto one user, or a link onto a user tied to another Rails id. */
  readonly linkConflicts: number;
  readonly total: number;
}

/**
 * Collisions among the plan's identity writes, checked on the ops themselves
 * (independent of `resolveIdentities`, which should never produce one). Emails
 * compare by the column collation's key when the store read it.
 */
export function emailMoveCollisions(
  ops: readonly DeltaOp[],
  snapshot: Pick<CbSnapshot, "users" | "exportEmailKeys">,
): EmailMoveCollisions {
  const keyFor = emailKeyFor(snapshot);
  const holders = new Map<string, Set<string>>();
  for (const user of snapshot.users) {
    for (const key of [
      keyFor(user.email),
      ...user.matchedExportEmails.map((email) => keyFor(email)),
    ]) {
      const set = holders.get(key) ?? new Set<string>();
      set.add(user.id);
      holders.set(key, set);
    }
  }
  const legacyById = new Map(snapshot.users.map((user) => [user.id, user.legacyRailsUserId]));
  const targets = new Map<string, number>();
  let targetHeld = 0;
  let linkConflicts = 0;
  const linked = new Set<string>();
  for (const op of ops) {
    if (op.kind === "user_email_update" || op.kind === "user_create") {
      const writer = op.kind === "user_create" ? op.user.id : op.userId;
      const key = keyFor(op.kind === "user_create" ? op.user.email : op.email);
      targets.set(key, (targets.get(key) ?? 0) + 1);
      if ([...(holders.get(key) ?? [])].some((holder) => holder !== writer)) targetHeld++;
    } else if (op.kind === "user_link") {
      const legacy = legacyById.get(op.userId) ?? null;
      if (linked.has(op.userId) || (legacy !== null && legacy !== op.railsUserId)) linkConflicts++;
      linked.add(op.userId);
    }
  }
  const sameTarget = [...targets.values()].reduce((sum, n) => sum + Math.max(0, n - 1), 0);
  return { sameTarget, targetHeld, linkConflicts, total: sameTarget + targetHeld + linkConflicts };
}

export interface DeltaAnalysis {
  readonly pass: DeltaPass;
  readonly snapshot: CbSnapshot;
  /** The plan for this pass (`ops` holds only this pass's ops). */
  readonly plan: DeltaPlan;
  /** Identity pass only: the full plan's verdict once the identity ops land. */
  readonly afterIdentityPass: {
    readonly underGrantUsers: number;
    readonly overGrantUsers: number;
    readonly identityConflicts: number;
    readonly fullPlanOps: number;
  } | null;
  readonly before: ShadowResult;
  readonly after: ShadowResult;
  /** Ops a second pass would still want after simulating this plan. Must be 0. */
  readonly remainingAfterSimulation: number;
  readonly largeRevoke: {
    /** Every op that removes or moves access. */
    readonly revokes: number;
    readonly entitlementRevokes: number;
    readonly membershipRevokes: number;
    /** `entitlement_update` that changes the user, type or organization. */
    readonly entitlementMoves: number;
    /** `membership_update` that clears `hasAccountMemberRole`. */
    readonly seatClearsByUpdate: number;
    /** `entitlement_expire` on a lenient subscription row (the runtime ignores its expiry). */
    readonly subscriptionExpires: number;
    readonly threshold: number;
    readonly tripped: boolean;
  };
  readonly proCrossCheck: ProCrossCheck;
  /** `user_email_update` plus `user_link` in this pass, and collisions among identity writes. */
  readonly identityOps: {
    readonly emailUpdates: number;
    readonly links: number;
    readonly count: number;
    readonly collisions: EmailMoveCollisions;
  };
}

export interface ProCrossCheck {
  /** Rails users holding the global `pro` role. */
  readonly railsProHolders: number;
  /** Export users granted all access without `pro`: roles, basic, seats, membership purchases, live backing. */
  readonly exportProEquivalent: number;
  /**
   * Bare `pro` held for a person: Rails says pro, nothing else in the export
   * grants the user, and they did not sign in within `--bare-pro-active-days`.
   */
  readonly bareProHolders: {
    readonly count: number;
    /** sha256 of the sorted ids, one per line: what `--accept-bare-pro` names. */
    readonly sha256: string;
    /** 20 ids spread across the sorted list, for checking by hand in Rails. */
    readonly sample: readonly string[];
    readonly railsUserIds: readonly string[];
  };
  /** Bare `pro` granted (`rails_bare_pro_active`): signed in inside the window, or keeping an earlier row. */
  readonly bareProActive: {
    readonly count: number;
    readonly keptFromEarlierRun: number;
    readonly railsUserIds: readonly string[];
  };
  /** Every bare holder (granted or held) by latest sign-in before the export. */
  readonly bareProSignIn: {
    readonly within90Days: number;
    readonly within1Year: number;
    readonly within3Years: number;
    readonly older: number;
    readonly never: number;
  };
  /** The export grants pro-equivalent access, Rails has no `pro` (sync lag; reported). */
  readonly exportHasRailsLacks: number;
  readonly exportHasRailsLacksSample: readonly string[];
}

/** Up to 20 ids spread evenly across a sorted list (first and last included). */
export function spreadSample(sorted: readonly string[], size = SAMPLE_SIZE): string[] {
  if (sorted.length <= size) return [...sorted];
  return Array.from({ length: size }, (_, index) => {
    const at = Math.round((index * (sorted.length - 1)) / (size - 1));
    return sorted[at] ?? "";
  });
}

const byRailsId = (a: string, b: string) => Number(a) - Number(b) || a.localeCompare(b);

/** sha256 of Rails user ids, sorted, one per line. */
export function railsIdListSha256(railsUserIds: readonly string[]) {
  return createHash("sha256")
    .update([...railsUserIds].toSorted(byRailsId).join("\n"))
    .digest("hex");
}

/** Holders by latest sign-in before `nowMs`. */
export function signInBuckets(holders: readonly RailsProHolder[], nowMs: number) {
  const buckets = { within90Days: 0, within1Year: 0, within3Years: 0, older: 0, never: 0 };
  for (const holder of holders) {
    const iso = railsTimestampToIso(holder.lastSignInOn);
    const days = iso === null ? Number.NaN : (nowMs - Date.parse(iso)) / 86_400_000;
    if (Number.isNaN(days)) buckets.never++;
    else if (days <= 90) buckets.within90Days++;
    else if (days <= 365) buckets.within1Year++;
    else if (days <= 3 * 365) buckets.within3Years++;
    else buckets.older++;
  }
  return buckets;
}

/**
 * Compare the export with Rails' own decision. Rails gates lessons on `is_pro?`
 * (`Ability#lesson_permissions`, which also unlocks `is_basic?` and
 * `is_instructor?`). The plan's `barePro` split holds the pro holders nothing
 * else grants; held stale legacy subscriptions and orphans have their own lists.
 */
export function proCrossCheck(
  railsExport: RailsAccessExport,
  plan: Pick<DeltaPlan, "liveBackingGrants" | "barePro">,
  nowMs: number,
): ProCrossCheck {
  const exportPro = exportProEquivalent(railsExport, plan.liveBackingGrants);
  const railsPro = new Set(railsExport.proHolders.map((holder) => holder.railsUserId));
  // Granted without `pro` by Rails itself: roles, basic, membership purchases.
  const withoutProByRails = new Set([
    ...railsExport.roleGrants.map((grant) => grant.railsUserId),
    ...railsExport.basicGrants.map((grant) => grant.railsUserId),
    ...railsExport.purchases
      .filter((purchase) => purchase.sellableType === "Resource::Membership")
      .map((purchase) => purchase.railsUserId),
  ]);
  const held = plan.barePro.held.map((holder) => holder.railsUserId);
  const extra = [...exportPro]
    .filter((railsUserId) => !railsPro.has(railsUserId) && !withoutProByRails.has(railsUserId))
    .toSorted(byRailsId);
  const buckets = signInBuckets(plan.barePro.all, nowMs);
  return {
    railsProHolders: railsPro.size,
    exportProEquivalent: exportPro.size,
    bareProHolders: {
      count: held.length,
      sha256: railsIdListSha256(held),
      sample: spreadSample(held),
      railsUserIds: held,
    },
    bareProActive: {
      count: plan.barePro.active.length,
      keptFromEarlierRun: plan.barePro.kept.length,
      railsUserIds: plan.barePro.active.map((holder) => holder.railsUserId),
    },
    bareProSignIn: buckets,
    exportHasRailsLacks: extra.length,
    exportHasRailsLacksSample: extra.slice(0, SAMPLE_SIZE),
  };
}

function bySource(grants: readonly RailsBackingGrant[]): Record<BackingSourceType, number> {
  const counts: Record<BackingSourceType, number> = {
    rails_gift: 0,
    rails_managed_subscription: 0,
    rails_legacy_subscription: 0,
  };
  for (const grant of grants) counts[BACKING_SOURCE_TYPES[grant.source]]++;
  return counts;
}

/**
 * Backed-`pro` rows per source type (granted rows only), backing for users
 * Rails does not grant as pro (counted, not granted), and granted legacy
 * subscriptions already past their period end (inside the stale window).
 */
export function backingCounts(railsExport: RailsAccessExport, plan: DeltaPlan, nowMs: number) {
  // The SQL counts these without exporting them; any that reach the export anyway add on.
  const inExport = bySource(plan.backingWithoutPro);
  const counted = railsExport.manifest.backedWithoutPro;
  return {
    bySourceType: plan.expected.policy.backingGrants,
    backedWithoutPro: {
      rails_gift: inExport.rails_gift + (counted?.gift ?? 0),
      rails_managed_subscription:
        inExport.rails_managed_subscription + (counted?.managed_subscription ?? 0),
      rails_legacy_subscription:
        inExport.rails_legacy_subscription + (counted?.legacy_subscription ?? 0),
    },
    legacySubscriptionsPastPeriodEnd: plan.liveBackingGrants.filter((grant) => {
      if (grant.source !== "legacy_subscription") return false;
      const iso = railsTimestampToIso(grant.currentPeriodEnd);
      return iso !== null && Date.parse(iso) < nowMs;
    }).length,
  };
}

/** A held list with the sha256 a person accepts it by. */
function heldList(ids: readonly string[]) {
  const sorted = [...ids].toSorted(byRailsId);
  return { count: sorted.length, sha256: railsIdListSha256(sorted) };
}

/** Source types whose count more than doubled since the previous receipt. */
export function backingGrowth(
  current: Record<GatedSourceType, number>,
  previous: Partial<Record<string, number>> | null,
) {
  if (previous === null) return [];
  const types: readonly GatedSourceType[] = [
    ...Object.values(BACKING_SOURCE_TYPES),
    BARE_PRO_ACTIVE_SOURCE_TYPE,
  ];
  return types.flatMap((sourceType) => {
    const before = previous[sourceType] ?? 0;
    const now = current[sourceType];
    return now > 2 * before ? [{ sourceType, previous: before, current: now }] : [];
  });
}

function hasReason(op: DeltaOp, reasons: readonly string[]) {
  return "reasons" in op && op.reasons.some((reason) => reasons.includes(reason));
}

export function analyze(
  railsExport: RailsAccessExport,
  snapshot: CbSnapshot,
  nowMs: number,
  options: AnalyzeOptions = {},
): DeltaAnalysis {
  const pass = options.pass ?? "full";
  const planOptions = {
    ...(options.seatFlagRulings === undefined ? {} : { seatFlagRulings: options.seatFlagRulings }),
    ...(options.legacyStaleDays === undefined ? {} : { legacyStaleDays: options.legacyStaleDays }),
    ...(options.bareProActiveDays === undefined
      ? {}
      : { bareProActiveDays: options.bareProActiveDays }),
  };
  const nowIso = new Date(nowMs).toISOString();
  const fullPlan = computeDeltaPlan(railsExport, snapshot, nowMs, planOptions);
  const forPass = (ops: readonly DeltaOp[]) =>
    pass === "identity" ? ops.filter((op) => IDENTITY_OP_KINDS.has(op.kind)) : ops;
  const plan: DeltaPlan = { ...fullPlan, ops: forPass(fullPlan.ops) };
  // The shadow's Rails side is what the plan grants: held and pro-less backing
  // removed, bare-active `pro` added, dormant pro-only users out of scope.
  const projected = fullPlan.projectedExport;
  const extra = fullPlan.barePro.active.map((holder) => ({
    railsUserId: holder.railsUserId,
    why: `bare pro, last sign-in ${holder.lastSignInOn ?? "never"}`,
  }));
  const before = compareShadow(projected, snapshot, plan.identities, nowMs, extra);
  const simulated = simulateApply(snapshot, plan.ops, nowIso);
  const afterIdentities = resolveIdentities(projected, simulated);
  const after = compareShadow(projected, simulated, afterIdentities, nowMs, extra);
  const nextPlan = computeDeltaPlan(railsExport, simulated, nowMs, planOptions);
  const remainingAfterSimulation = forPass(nextPlan.ops).length;

  let afterIdentityPass: DeltaAnalysis["afterIdentityPass"] = null;
  if (pass === "identity") {
    const fullSimulated = simulateApply(simulated, nextPlan.ops, nowIso);
    const fullAfter = compareShadow(
      projected,
      fullSimulated,
      resolveIdentities(projected, fullSimulated),
      nowMs,
      extra,
    );
    afterIdentityPass = {
      underGrantUsers: fullAfter.summary.underGrantUsers,
      overGrantUsers: fullAfter.summary.overGrantUsers,
      identityConflicts: identityConflicts(nextPlan.identities).total,
      fullPlanOps: nextPlan.ops.length,
    };
  }

  const count = (test: (op: DeltaOp) => boolean) => plan.ops.filter(test).length;
  const subscriptionRows = new Set(
    snapshot.entitlements
      .filter((row) => row.sourceType === "rails_account_subscription")
      .map((row) => row.id),
  );
  const entitlementRevokes = count((op) => op.kind === "entitlement_revoke");
  const membershipRevokes = count((op) => op.kind === "membership_revoke");
  const entitlementMoves = count(
    (op) =>
      op.kind === "entitlement_update" &&
      hasReason(op, ["userId_changed", "entitlementType_changed", "organizationId_changed"]),
  );
  const seatClearsByUpdate = count(
    (op) =>
      op.kind === "membership_update" &&
      op.membership.fields["hasAccountMemberRole"] === false &&
      hasReason(op, ["fields_hasAccountMemberRole_changed"]),
  );
  const subscriptionExpires = count(
    (op) => op.kind === "entitlement_expire" && subscriptionRows.has(op.entitlementId),
  );
  const revokes =
    entitlementRevokes +
    membershipRevokes +
    entitlementMoves +
    seatClearsByUpdate +
    subscriptionExpires;
  const threshold = Math.max(
    50,
    Math.ceil((plan.activeOwnedEntitlements + plan.activeRailsSeatFlags) * 0.01),
  );
  return {
    pass,
    snapshot,
    plan,
    afterIdentityPass,
    before,
    after,
    remainingAfterSimulation,
    largeRevoke: {
      revokes,
      entitlementRevokes,
      membershipRevokes,
      entitlementMoves,
      seatClearsByUpdate,
      subscriptionExpires,
      threshold,
      tripped: revokes > threshold,
    },
    proCrossCheck: proCrossCheck(railsExport, fullPlan, nowMs),
    identityOps: {
      emailUpdates: count((op) => op.kind === "user_email_update"),
      links: count((op) => op.kind === "user_link"),
      count: count((op) => IDENTITY_OP_KINDS.has(op.kind)),
      collisions: emailMoveCollisions(plan.ops, snapshot),
    },
  };
}

export async function analyzeDatabase(
  db: EggheadDatabase,
  railsExport: RailsAccessExport,
  nowMs: number,
  readOptions: SnapshotReadOptions = DEFAULT_READ_OPTIONS,
  options: AnalyzeOptions = {},
) {
  return analyze(railsExport, await readCbSnapshot(db, railsExport, readOptions), nowMs, options);
}

/**
 * The clock the analysis uses. Rails decided "expired" at export time, so the
 * default is the manifest's `exportedAt`; an explicit override wins.
 */
export function analysisClockMs(railsExport: RailsAccessExport, overrideMs: number | null) {
  if (overrideMs !== null) return overrideMs;
  const exported = Date.parse(railsExport.manifest.exportedAt);
  if (Number.isNaN(exported)) throw new Error("manifest exportedAt is not a timestamp");
  return exported;
}

/** Parse `90m`, `2h`, `1d` or bare seconds into milliseconds. */
export function parseDurationMs(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)?$/.exec(value.trim());
  if (!match?.[1]) return null;
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] ?? "s"] ?? 1000;
  return Number(match[1]) * unit;
}

export const DEFAULT_MAX_EXPORT_AGE_MS = 2 * 3_600_000;

/** The way out of a refused or failed apply. A locked --out cannot take a new dry run. */
export const NEW_OUT_ADVICE =
  "dry-run into a NEW --out folder, review that receipt, and --apply that plan. " +
  "Any partial apply in the old folder is safe to leave: every write is idempotent and the new plan accounts for it";
/** Clock skew tolerated before an export counts as from the future. */
const EXPORT_CLOCK_SKEW_MS = 5 * 60_000;

export interface ApplyPreconditions {
  readonly expectPlan: string | undefined;
  readonly reviewedPlan: {
    readonly planSha256: string;
    readonly exportSha256: string;
    readonly database: string;
    readonly hostSha256: string;
  };
  readonly exportSha256: string;
  readonly database: string;
  readonly hostSha256: string;
  /** The manifest's `exportedAt`, and the wall clock at apply. */
  readonly exportedAtMs: number;
  readonly nowMs: number;
  readonly maxExportAgeMs: number;
  /** Plan sha computed from CourseBuilder right now. */
  readonly freshPlanSha256: string;
  /**
   * What the fresh plan must be: the reviewed plan's sha for `--apply`. For
   * `--resume`, the fresh ops must all be in the plan's unapplied tail
   * (`freshOpsOutsidePlan` must be 0; ops already applied may be missing).
   */
  readonly resume?: { readonly freshOpsOutsidePlan: number };
  readonly gate: { readonly pass: boolean; readonly failures: readonly string[] };
}

/** Every reason `--apply` must refuse. Empty means go. */
export function applyRefusals(input: ApplyPreconditions): string[] {
  const refusals: string[] = [];
  if (!input.expectPlan) {
    refusals.push("--apply needs --expect-plan <planSha256> from the reviewed dry run receipt");
  } else if (input.expectPlan !== input.reviewedPlan.planSha256) {
    refusals.push(
      `--expect-plan ${input.expectPlan} does not match the saved plan ${input.reviewedPlan.planSha256}`,
    );
  }
  if (input.reviewedPlan.exportSha256 !== input.exportSha256) {
    refusals.push("the saved plan was computed from a different export file");
  }
  if (input.reviewedPlan.database !== input.database) {
    refusals.push(`the saved plan targets ${input.reviewedPlan.database}, not ${input.database}`);
  }
  if (input.reviewedPlan.hostSha256 !== input.hostSha256) {
    refusals.push("the saved plan was computed against a different database host");
  }
  const ageMs = input.nowMs - input.exportedAtMs;
  if (ageMs > input.maxExportAgeMs) {
    refusals.push(
      `the export is ${Math.round(ageMs / 60_000)} minutes old, over --max-export-age ` +
        `${Math.round(input.maxExportAgeMs / 60_000)} minutes; export Rails again and rerun the dry run`,
    );
  } else if (ageMs < -EXPORT_CLOCK_SKEW_MS) {
    refusals.push("the export's exportedAt is in the future; check the clocks");
  }
  const drifted = input.resume
    ? input.resume.freshOpsOutsidePlan > 0
    : input.freshPlanSha256 !== input.reviewedPlan.planSha256;
  if (drifted) {
    refusals.push(
      `CourseBuilder changed since the reviewed dry run${input.resume ? ` (${input.resume.freshOpsOutsidePlan} ops the saved plan does not have)` : ""}; ` +
        NEW_OUT_ADVICE,
    );
  }
  if (!input.gate.pass) {
    refusals.push(...input.gate.failures.map((failure) => `gate: ${failure}`));
  }
  return refusals;
}

function sampleOp(op: DeltaOp): Record<string, unknown> {
  switch (op.kind) {
    case "user_create":
      return { kind: op.kind, userId: op.user.id, railsUserId: op.railsUserId, role: op.user.role };
    case "user_link":
    case "user_email_update":
      // No emails in samples: the receipt stays free of customer data.
      return { kind: op.kind, userId: op.userId, railsUserId: op.railsUserId };
    case "organization_create":
      return { kind: op.kind, organizationId: op.organization.id };
    case "membership_create":
    case "membership_update":
      return {
        kind: op.kind,
        membershipId: op.membership.id,
        organizationId: op.membership.organizationId,
        userId: op.membership.userId,
        role: op.membership.role,
        hasAccountMemberRole: op.membership.fields["hasAccountMemberRole"],
        reasons: op.reasons,
      };
    case "membership_revoke":
      return { kind: op.kind, membershipId: op.membershipId };
    case "entitlement_grant":
    case "entitlement_extend":
    case "entitlement_update":
      return {
        kind: op.kind,
        entitlementId: op.entitlement.id,
        entitlementType: op.entitlement.entitlementType,
        userId: op.entitlement.userId,
        organizationId: op.entitlement.organizationId,
        sourceType: op.entitlement.sourceType,
        sourceId: op.entitlement.sourceId,
        status: op.entitlement.metadata["status"],
        expiresAt: op.entitlement.expiresAt,
        currentPeriodEnd: op.entitlement.metadata["currentPeriodEnd"],
        reasons: op.reasons,
      };
    default:
      return { kind: op.kind, entitlementId: op.entitlementId };
  }
}

/** Up to 20 ops, round-robin across change classes so every class shows up. */
export function sampleOps(ops: readonly DeltaOp[], size = SAMPLE_SIZE) {
  const byKind = new Map<DeltaOpKind, DeltaOp[]>();
  for (const op of ops) {
    const list = byKind.get(op.kind);
    if (list) list.push(op);
    else byKind.set(op.kind, [op]);
  }
  const samples: Record<string, unknown>[] = [];
  for (let round = 0; samples.length < size; round++) {
    let added = false;
    for (const kind of DELTA_OP_KINDS) {
      const op = byKind.get(kind)?.[round];
      if (!op || samples.length >= size) continue;
      samples.push(sampleOp(op));
      added = true;
    }
    if (!added) break;
  }
  return samples;
}

function countBy<T>(values: readonly T[], key: (value: T) => string) {
  const counts: Record<string, number> = {};
  for (const value of values) counts[key(value)] = (counts[key(value)] ?? 0) + 1;
  return counts;
}

function shadowSample(user: UserShadow) {
  return {
    cbUserId: user.cbUserId,
    railsUserIds: user.railsUserIds,
    identity: user.identity,
    underGrant: user.underGrant,
    overGrant: user.overGrant,
  };
}

function shadowBlock(shadow: ShadowResult) {
  return {
    ...shadow.summary,
    underGrantSamples: shadow.users
      .filter((user) => user.underGrant.length > 0)
      .slice(0, SAMPLE_SIZE)
      .map(shadowSample),
    overGrantSamples: shadow.users
      .filter((user) => user.overGrant.length > 0)
      .slice(0, SAMPLE_SIZE)
      .map(shadowSample),
  };
}

export interface ReceiptContext {
  readonly mode: "dry-run" | "apply" | "resume";
  readonly generatedAt: string;
  /** The host is stored hashed (`hostSha256`), never as written. */
  readonly target: {
    readonly runtime: string;
    readonly hostSha256: string;
    readonly database: string;
  };
  /**
   * Every flag that moves the gate, as the plan records them. Held lists are
   * accepted by the sha256 of the exact id set, so a changed list fails again
   * even at the same size.
   */
  readonly gateInputs: GateInputs;
  /** Backed-`pro` counts from the previous run's receipt, for the growth alarm. */
  readonly previousBackingCounts: Partial<Record<string, number>> | null;
}

/** Gate inputs with nothing accepted: a first dry run. */
export function defaultGateInputs(overrides: Partial<GateInputs> = {}): GateInputs {
  return Object.assign(
    {
      allowLargeRevoke: false,
      acceptBarePro: null,
      acceptStaleLegacy: null,
      acceptOrphanGrants: null,
      acceptFirstBacking: {},
      previousReceiptSha256: null,
      allowBackingGrowth: false,
      seatFlagRulings: {},
      maxIdentityOps: DEFAULT_MAX_IDENTITY_OPS,
      legacyStaleDays: DEFAULT_LEGACY_STALE_DAYS,
      bareProActiveDays: DEFAULT_BARE_PRO_ACTIVE_DAYS,
    },
    overrides,
  );
}

export function buildReceipt(
  railsExport: RailsAccessExport,
  analysis: DeltaAnalysis,
  context: ReceiptContext,
) {
  const { plan, before, after } = analysis;
  const byClass: Record<string, number> = {};
  for (const kind of DELTA_OP_KINDS) byClass[kind] = 0;
  for (const op of plan.ops) byClass[op.kind] = (byClass[op.kind] ?? 0) + 1;
  const reasons = countBy(
    plan.ops.flatMap((op) =>
      "reasons" in op ? op.reasons.map((reason) => `${op.kind}:${reason}`) : [],
    ),
    (reason) => reason,
  );
  const identity = countBy([...plan.identities.values()], (outcome) =>
    outcome.kind === "unresolved"
      ? `unresolved:${outcome.reason}`
      : outcome.kind === "matched" && outcome.emailUpdate
        ? "matched:email_update"
        : outcome.kind === "matched" && outcome.emailHeld
          ? "matched:email_update_held"
          : outcome.kind,
  );
  const conflicts = identityConflicts(plan.identities);
  const pro = analysis.proCrossCheck;
  const gate = context.gateInputs;
  const backing = backingCounts(railsExport, plan, Date.parse(railsExport.manifest.exportedAt));
  const growth = backingGrowth(backing.bySourceType, context.previousBackingCounts);
  const heldLegacy = {
    ...heldList(plan.heldLegacySubscriptions.map((held) => held.railsSourceId)),
    staleDays: gate.legacyStaleDays,
    subscriptions: plan.heldLegacySubscriptions,
    /** Every holder whose only backing is a stale legacy subscription, granted or held. */
    holderSignIn: signInBuckets(
      plan.barePro.staleOnly,
      Date.parse(railsExport.manifest.exportedAt),
    ),
    grantedInWindow: plan.barePro.staleOnly.filter((holder) =>
      plan.barePro.active.some((active) => active.railsUserId === holder.railsUserId),
    ).length,
    rowsKept: plan.revokeHeldForStaleLegacy,
  };
  const orphans = {
    ...heldList(railsExport.orphanRailsUserIds),
    railsUserIds: railsExport.orphanRailsUserIds,
    rowsKept: plan.revokeHeldForOrphan,
  };
  // An over-grant is accepted only when every owned row behind it is one a
  // hold keeps, or reaches the user through a seat a person ruled `keep`.
  const keptMemberships = new Set(
    plan.heldSeatFlags.filter((held) => held.ruling === "keep").map((held) => held.membershipId),
  );
  const pathAccepted = (path: UserShadow["overGrantPaths"][number]) =>
    plan.heldEntitlementIds.has(path.entitlementId) ||
    (path.membershipId !== null &&
      (keptMemberships.has(path.membershipId) || plan.heldMembershipIds.has(path.membershipId)));
  const overGranted = after.users.filter((user) => user.overGrant.length > 0);
  const accepted = overGranted.filter(
    (user) => user.overGrantPaths.length > 0 && user.overGrantPaths.every(pathAccepted),
  );
  const overGrantAccepted = accepted.filter((user) =>
    user.overGrantPaths.some(
      (path) => path.membershipId !== null && keptMemberships.has(path.membershipId),
    ),
  ).length;
  const overGrantAcceptedByHold = accepted.length - overGrantAccepted;
  const identityOps = {
    ...analysis.identityOps,
    max: gate.maxIdentityOps,
    tripped: analysis.identityOps.count > gate.maxIdentityOps,
  };

  const failures: string[] = [];
  if (analysis.remainingAfterSimulation > 0) {
    failures.push(
      `plan does not converge: ${analysis.remainingAfterSimulation} ops remain after simulation`,
    );
  }
  // ShadowResult.users is the complete list; the summary is counted from it.
  for (const shadow of [before, after]) {
    const under = shadow.users.filter((user) => user.underGrant.length > 0).length;
    const over = shadow.users.filter((user) => user.overGrant.length > 0).length;
    if (under !== shadow.summary.underGrantUsers || over !== shadow.summary.overGrantUsers) {
      failures.push("the shadow summary disagrees with its user list; refusing to trust either");
    }
  }
  if (identityOps.tripped) {
    failures.push(
      `${identityOps.count} identity ops (${identityOps.emailUpdates} email updates, ${identityOps.links} links) ` +
        `exceed --max-identity-ops ${gate.maxIdentityOps}; review them, then raise --max-identity-ops`,
    );
  }
  if (identityOps.collisions.total > 0) {
    failures.push(
      `${identityOps.collisions.total} identity writes collide (${identityOps.collisions.sameTarget} onto the same email, ` +
        `${identityOps.collisions.targetHeld} onto an email another user holds, ${identityOps.collisions.linkConflicts} conflicting links); ` +
        "the store would refuse them; resolve the accounts by hand",
    );
  }
  if (analysis.pass === "full") {
    if (after.summary.underGrantUsers > 0) {
      failures.push(
        `${after.summary.underGrantUsers} users would still be under-granted after apply`,
      );
    }
    const overGrantHeld = overGranted.length - accepted.length;
    if (overGrantHeld > 0) {
      failures.push(`${overGrantHeld} users would still be over-granted after apply`);
    }
    if (conflicts.total > 0) {
      failures.push(
        `${conflicts.total} identity conflicts (${conflicts.duplicateEmail} duplicate Rails emails, ` +
          `${conflicts.emailOwnedByOtherRailsUser} emails owned by another Rails user, ` +
          `${conflicts.emailUpdateHeld} email updates held); if the plan has user_email_update or user_link ops, ` +
          "run the identity pass (--identity-pass) first, then the full dry run again",
      );
    }
    if (pro.bareProHolders.count > 0 && pro.bareProHolders.sha256 !== gate.acceptBarePro) {
      failures.push(
        `${pro.bareProHolders.count} bare pro holders (pro role, no special role, seat or live backing; ids in proCrossCheck.bareProHolders); ` +
          "rule on them, then pass --accept-bare-pro with proCrossCheck.bareProHolders.sha256",
      );
    }
    if (heldLegacy.count > 0 && heldLegacy.sha256 !== gate.acceptStaleLegacy) {
      failures.push(
        `${heldLegacy.count} legacy subscriptions held as stale (period end over ${gate.legacyStaleDays} days past, or none, ` +
          `and no sign-in within ${gate.bareProActiveDays} days; ` +
          "ids in heldLegacySubscriptions); rule on them, then pass --accept-stale-legacy with heldLegacySubscriptions.sha256",
      );
    }
    if (orphans.count > 0 && orphans.sha256 !== gate.acceptOrphanGrants) {
      failures.push(
        `${orphans.count} Rails users have grant lines but no user line (ids in orphanGrants); ` +
          "their grants are held; pass --accept-orphan-grants with orphanGrants.sha256",
      );
    }
    for (const [sourceType, current] of Object.entries(backing.bySourceType)) {
      const acceptedCount = gate.acceptFirstBacking[sourceType];
      if (acceptedCount !== undefined && acceptedCount !== current) {
        failures.push(
          `--accept-first-backing ${sourceType}=${acceptedCount} but the plan grants ${current}`,
        );
      } else if (
        context.previousBackingCounts === null &&
        current > 0 &&
        acceptedCount === undefined
      ) {
        failures.push(
          `first run: ${current} ${sourceType} grants and no --previous-receipt; review them, then pass --accept-first-backing ${sourceType}=${current}`,
        );
      }
    }
    for (const sourceType of Object.keys(gate.acceptFirstBacking)) {
      if (!(sourceType in backing.bySourceType)) {
        failures.push(`--accept-first-backing names an unknown source type: ${sourceType}`);
      }
    }
    for (const item of growth) {
      if (gate.allowBackingGrowth) break;
      failures.push(
        `${item.sourceType} grew from ${item.previous} to ${item.current} (over 2x the previous run); review, then pass --allow-backing-growth`,
      );
    }
    if (plan.unusedSeatFlagOverrides.length > 0) {
      failures.push(
        `--held-seat-flag names memberships that are not held: ${plan.unusedSeatFlagOverrides.join(", ")}`,
      );
    }
    if (analysis.largeRevoke.tripped && !gate.allowLargeRevoke) {
      failures.push(
        `${analysis.largeRevoke.revokes} revokes and access moves exceed the alarm threshold ${analysis.largeRevoke.threshold}; review samples, then pass --allow-large-revoke`,
      );
    }
  }

  return {
    format: RECEIPT_FORMAT,
    mode: context.mode,
    pass: analysis.pass,
    generatedAt: context.generatedAt,
    law: ACCESS_DELTA_LAW,
    target: context.target,
    export: {
      sha256: railsExport.sha256,
      exportedAt: railsExport.manifest.exportedAt,
      counts: railsExport.manifest.counts,
      manifestVerified: true,
    },
    cbSnapshot: {
      usersMatched: analysis.snapshot.users.length,
      entitlementsRead: analysis.snapshot.entitlements.length,
      activeOwnedEntitlements: plan.activeOwnedEntitlements,
      membershipsRead: analysis.snapshot.memberships.length,
      organizationsFound: analysis.snapshot.organizationIds.length,
    },
    changes: {
      total: plan.ops.length,
      byClass,
      reasons,
      planSha256: planSha256(plan.ops),
    },
    identity,
    identityConflicts: conflicts,
    gateInputs: gate,
    proCrossCheck: { ...pro, acceptedBareProSha256: gate.acceptBarePro },
    backingGrants: { ...backing, growth, previous: context.previousBackingCounts },
    heldLegacySubscriptions: heldLegacy,
    orphanGrants: orphans,
    identityOps,
    heldSeatFlags: plan.heldSeatFlags,
    overGrantAcceptedBySeatFlagKeep: overGrantAccepted,
    overGrantAcceptedByHold,
    afterIdentityPass: analysis.afterIdentityPass,
    policy: {
      ...plan.expected.policy,
      revokeHeldForIdentity: plan.revokeHeldForIdentity,
      membershipRevokeHeldForIdentity: plan.membershipRevokeHeldForIdentity,
      membershipFlagHeldForNativeOrganization: plan.membershipFlagHeldForNativeOrganization,
    },
    samples: sampleOps(plan.ops),
    shadow: {
      before: shadowBlock(before),
      afterSimulatedApply: shadowBlock(after),
      remainingOpsAfterSimulation: analysis.remainingAfterSimulation,
    },
    largeRevoke: analysis.largeRevoke,
    gate: { pass: failures.length === 0, failures },
  };
}

export type DeltaReceipt = ReturnType<typeof buildReceipt>;

export interface ApplyRunOptions {
  readonly batchSize: number;
  /** Analysis clock for the post-apply verification (the export's time). */
  readonly analysisNowMs: number;
  readonly readOptions?: SnapshotReadOptions;
  readonly maxBatches?: number;
  readonly now: () => Date;
  readonly saveCursor: (cursor: ApplyCursor) => Promise<void>;
  /** Passed through to the verification re-read (seat-flag rulings, pass). */
  readonly analyzeOptions?: AnalyzeOptions;
}

/** Execute ops from a cursor, then re-read CourseBuilder and verify. */
export async function applyAndVerify(
  db: EggheadDatabase,
  railsExport: RailsAccessExport,
  ops: readonly DeltaOp[],
  cursor: ApplyCursor,
  options: ApplyRunOptions,
) {
  const batchTimings: BatchTiming[] = [];
  const finalCursor = await applyDeltaOps(db, ops, cursor, {
    batchSize: options.batchSize,
    ...(options.maxBatches === undefined ? {} : { maxBatches: options.maxBatches }),
    now: options.now,
    saveCursor: options.saveCursor,
    onBatch: (timing) => {
      batchTimings.push(timing);
    },
  });
  const verify = await analyzeDatabase(
    db,
    railsExport,
    options.analysisNowMs,
    options.readOptions ?? DEFAULT_READ_OPTIONS,
    options.analyzeOptions ?? {},
  );
  const totalMs = batchTimings.reduce((sum, timing) => sum + timing.ms, 0);
  return {
    cursor: finalCursor,
    timing: {
      batches: batchTimings.length,
      totalMs,
      maxMs: batchTimings.reduce((max, timing) => Math.max(max, timing.ms), 0),
      perBatch: batchTimings,
    },
    verify: {
      remainingOps: verify.plan.ops.length,
      remainingByClass: countBy(verify.plan.ops, (op) => op.kind),
      underGrantUsers: verify.before.summary.underGrantUsers,
      overGrantUsers: verify.before.summary.overGrantUsers,
      missingIdentityUsers: verify.before.summary.missingIdentityUsers,
    },
    verifyAnalysis: verify,
  };
}
