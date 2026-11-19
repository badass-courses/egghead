import { createHash } from "node:crypto";

// Orchestration shared by the access-delta CLI and its tests: read CourseBuilder,
// compute the plan, simulate it, shadow-compare before and after, build the
// receipt, and (on apply) execute and verify.

import {
  ACCESS_DELTA_LAW,
  computeDeltaPlan,
  BACKING_SOURCE_TYPES,
  DELTA_OP_KINDS,
  IDENTITY_OP_KINDS,
  identityConflicts,
  resolveIdentities,
  simulateApply,
  type BackingSourceType,
  type CbSnapshot,
  type DeltaOp,
  type DeltaOpKind,
  type DeltaPlan,
  type RailsAccessExport,
  type SeatFlagRuling,
} from "../apps/web/src/access/rails-access-delta";
import { planSha256, type ApplyCursor } from "../apps/web/src/access/rails-access-delta-plan";
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
}

export interface ProCrossCheck {
  /** Rails users holding the global `pro` role. */
  readonly railsProHolders: number;
  /** Export users granted pro-equivalent access: special roles, member seats, live backing. */
  readonly exportProEquivalent: number;
  /**
   * Bare `pro`: Rails says pro, and the export has no special role, no member
   * seat and no live backing for the user. Held for a person, by id.
   */
  readonly bareProHolders: {
    readonly count: number;
    /** sha256 of the sorted ids, one per line: what `--accept-bare-pro` names. */
    readonly sha256: string;
    readonly railsUserIds: readonly string[];
  };
  /** The export grants pro-equivalent access, Rails has no `pro` (sync lag; reported). */
  readonly exportHasRailsLacks: number;
  readonly exportHasRailsLacksSample: readonly string[];
}

const byRailsId = (a: string, b: string) => Number(a) - Number(b) || a.localeCompare(b);

/** sha256 of Rails user ids, sorted, one per line. */
export function railsIdListSha256(railsUserIds: readonly string[]) {
  return createHash("sha256")
    .update([...railsUserIds].toSorted(byRailsId).join("\n"))
    .digest("hex");
}

/**
 * Compare the export with Rails' own decision. Rails gates lessons on `is_pro?`
 * (`Ability#lesson_permissions`). The export grants the same people through
 * `Subscription::ProStatusChecker`'s two paths (special roles, `account_member`
 * on an enabled account subscription) plus live legacy backing (gifts, managed
 * subscriptions, legacy subscriptions), which ProStatusChecker ignores and
 * ADR-0006 lenient keeps. Anyone left is bare `pro`.
 */
export function proCrossCheck(railsExport: RailsAccessExport): ProCrossCheck {
  const exportPro = new Set([
    ...railsExport.roleGrants.map((grant) => grant.railsUserId),
    ...railsExport.subscriptions.flatMap((sub) =>
      sub.members.filter((member) => member.hasMemberRole).map((member) => member.railsUserId),
    ),
    ...railsExport.backingGrants.map((grant) => grant.railsUserId),
  ]);
  const railsPro = new Set(railsExport.proHolders.map((holder) => holder.railsUserId));
  const bare = [...railsPro]
    .filter((railsUserId) => !exportPro.has(railsUserId))
    .toSorted(byRailsId);
  const extra = [...exportPro]
    .filter((railsUserId) => !railsPro.has(railsUserId))
    .toSorted(byRailsId);
  return {
    railsProHolders: railsPro.size,
    exportProEquivalent: exportPro.size,
    bareProHolders: { count: bare.length, sha256: railsIdListSha256(bare), railsUserIds: bare },
    exportHasRailsLacks: extra.length,
    exportHasRailsLacksSample: extra.slice(0, SAMPLE_SIZE),
  };
}

/** Backed-`pro` rows per source type, and legacy subscriptions past their period end. */
export function backingCounts(railsExport: RailsAccessExport, plan: DeltaPlan, nowMs: number) {
  return {
    bySourceType: plan.expected.policy.backingGrants,
    legacySubscriptionsStalePeriodEnd: railsExport.backingGrants.filter((grant) => {
      if (grant.source !== "legacy_subscription" || grant.currentPeriodEnd === null) return false;
      const end = Date.parse(
        /[zZ]|[+-]\d{2}:?\d{2}$/.test(grant.currentPeriodEnd)
          ? grant.currentPeriodEnd
          : `${grant.currentPeriodEnd.replace(" ", "T")}Z`,
      );
      return !Number.isNaN(end) && end < nowMs;
    }).length,
  };
}

/** Source types whose count more than doubled since the previous receipt. */
export function backingGrowth(
  current: Record<BackingSourceType, number>,
  previous: Partial<Record<string, number>> | null,
) {
  if (previous === null) return [];
  return Object.values(BACKING_SOURCE_TYPES).flatMap((sourceType) => {
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
  const planOptions =
    options.seatFlagRulings === undefined ? {} : { seatFlagRulings: options.seatFlagRulings };
  const nowIso = new Date(nowMs).toISOString();
  const fullPlan = computeDeltaPlan(railsExport, snapshot, nowMs, planOptions);
  const forPass = (ops: readonly DeltaOp[]) =>
    pass === "identity" ? ops.filter((op) => IDENTITY_OP_KINDS.has(op.kind)) : ops;
  const plan: DeltaPlan = { ...fullPlan, ops: forPass(fullPlan.ops) };
  const before = compareShadow(railsExport, snapshot, plan.identities, nowMs);
  const simulated = simulateApply(snapshot, plan.ops, nowIso);
  const afterIdentities = resolveIdentities(railsExport, simulated);
  const after = compareShadow(railsExport, simulated, afterIdentities, nowMs);
  const nextPlan = computeDeltaPlan(railsExport, simulated, nowMs, planOptions);
  const remainingAfterSimulation = forPass(nextPlan.ops).length;

  let afterIdentityPass: DeltaAnalysis["afterIdentityPass"] = null;
  if (pass === "identity") {
    const fullSimulated = simulateApply(simulated, nextPlan.ops, nowIso);
    const fullAfter = compareShadow(
      railsExport,
      fullSimulated,
      resolveIdentities(railsExport, fullSimulated),
      nowMs,
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
    proCrossCheck: proCrossCheck(railsExport),
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
  readonly allowLargeRevoke: boolean;
  /**
   * The sha256 of the bare-`pro` id list a person reviewed and accepted as not
   * paid access. A different list (even of the same size) fails the gate.
   * Backed users are never on the list: they are granted.
   */
  readonly acceptBarePro: string | null;
  /** Backed-`pro` counts from the previous run's receipt, for the growth alarm. */
  readonly previousBackingCounts: Partial<Record<string, number>> | null;
  readonly allowBackingGrowth: boolean;
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
  const backing = backingCounts(railsExport, plan, Date.parse(railsExport.manifest.exportedAt));
  const growth = backingGrowth(backing.bySourceType, context.previousBackingCounts);
  const keptSeatUsers = new Set(
    plan.heldSeatFlags.filter((held) => held.ruling === "keep").map((held) => held.userId),
  );
  const overGranted = after.users.filter((user) => user.overGrant.length > 0);
  const overGrantAccepted = overGranted.filter(
    (user) => user.cbUserId !== null && keptSeatUsers.has(user.cbUserId),
  ).length;

  const failures: string[] = [];
  if (analysis.remainingAfterSimulation > 0) {
    failures.push(
      `plan does not converge: ${analysis.remainingAfterSimulation} ops remain after simulation`,
    );
  }
  if (analysis.pass === "full") {
    if (after.summary.underGrantUsers > 0) {
      failures.push(
        `${after.summary.underGrantUsers} users would still be under-granted after apply`,
      );
    }
    const overGrantHeld = overGranted.length - overGrantAccepted;
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
    if (pro.bareProHolders.count > 0 && pro.bareProHolders.sha256 !== context.acceptBarePro) {
      failures.push(
        `${pro.bareProHolders.count} bare pro holders (pro role, no special role, seat or live backing; ids in proCrossCheck.bareProHolders); ` +
          "rule on them, then pass --accept-bare-pro with proCrossCheck.bareProHolders.sha256",
      );
    }
    for (const item of growth) {
      if (context.allowBackingGrowth) break;
      failures.push(
        `${item.sourceType} grew from ${item.previous} to ${item.current} (over 2x the previous run); review, then pass --allow-backing-growth`,
      );
    }
    if (plan.unusedSeatFlagOverrides.length > 0) {
      failures.push(
        `--held-seat-flag names memberships that are not held: ${plan.unusedSeatFlagOverrides.join(", ")}`,
      );
    }
    if (analysis.largeRevoke.tripped && !context.allowLargeRevoke) {
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
    proCrossCheck: { ...pro, acceptedBareProSha256: context.acceptBarePro },
    backingGrants: { ...backing, growth, previous: context.previousBackingCounts },
    heldSeatFlags: plan.heldSeatFlags,
    overGrantAcceptedBySeatFlagKeep: overGrantAccepted,
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
