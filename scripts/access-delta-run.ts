// Orchestration shared by the access-delta CLI and its tests: read CourseBuilder,
// compute the plan, simulate it, shadow-compare before and after, build the
// receipt, and (on apply) execute and verify.

import {
  ACCESS_DELTA_LAW,
  computeDeltaPlan,
  DELTA_OP_KINDS,
  resolveIdentities,
  simulateApply,
  type CbSnapshot,
  type DeltaOp,
  type DeltaOpKind,
  type DeltaPlan,
  type RailsAccessExport,
} from "../apps/web/src/access/rails-access-delta";
import { planSha256, type ApplyCursor } from "../apps/web/src/access/rails-access-delta-plan";
import {
  applyDeltaOps,
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

export interface DeltaAnalysis {
  readonly snapshot: CbSnapshot;
  readonly plan: DeltaPlan;
  readonly before: ShadowResult;
  readonly after: ShadowResult;
  /** Ops a second pass would still want after simulating this plan. Must be 0. */
  readonly remainingAfterSimulation: number;
  readonly largeRevoke: {
    readonly revokes: number;
    readonly threshold: number;
    readonly tripped: boolean;
  };
}

export function analyze(
  railsExport: RailsAccessExport,
  snapshot: CbSnapshot,
  nowMs: number,
): DeltaAnalysis {
  const nowIso = new Date(nowMs).toISOString();
  const plan = computeDeltaPlan(railsExport, snapshot, nowMs);
  const before = compareShadow(railsExport, snapshot, plan.identities, nowMs);
  const simulated = simulateApply(snapshot, plan.ops, nowIso);
  const afterIdentities = resolveIdentities(railsExport, simulated);
  const after = compareShadow(railsExport, simulated, afterIdentities, nowMs);
  const remainingAfterSimulation = computeDeltaPlan(railsExport, simulated, nowMs).ops.length;
  const revokes = plan.ops.filter((op) => op.kind === "entitlement_revoke").length;
  const threshold = Math.max(50, Math.ceil(plan.activeOwnedEntitlements * 0.01));
  return {
    snapshot,
    plan,
    before,
    after,
    remainingAfterSimulation,
    largeRevoke: { revokes, threshold, tripped: revokes > threshold },
  };
}

export async function analyzeDatabase(
  db: EggheadDatabase,
  railsExport: RailsAccessExport,
  nowMs: number,
  readOptions: SnapshotReadOptions = DEFAULT_READ_OPTIONS,
) {
  return analyze(railsExport, await readCbSnapshot(db, railsExport, readOptions), nowMs);
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

export interface ApplyPreconditions {
  readonly expectPlan: string | undefined;
  readonly reviewedPlan: {
    readonly planSha256: string;
    readonly exportSha256: string;
    readonly database: string;
  };
  readonly exportSha256: string;
  readonly database: string;
  /** Plan sha computed from CourseBuilder right now. */
  readonly freshPlanSha256: string;
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
  if (input.freshPlanSha256 !== input.reviewedPlan.planSha256) {
    refusals.push(
      "CourseBuilder changed since the reviewed dry run; run the dry run again and review it",
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
  readonly target: { readonly runtime: string; readonly host: string; readonly database: string };
  readonly allowLargeRevoke: boolean;
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
    outcome.kind === "unresolved" ? `unresolved:${outcome.reason}` : outcome.kind,
  );

  const failures: string[] = [];
  if (after.summary.underGrantUsers > 0) {
    failures.push(
      `${after.summary.underGrantUsers} users would still be under-granted after apply`,
    );
  }
  if (after.summary.overGrantUsers > 0) {
    failures.push(`${after.summary.overGrantUsers} users would still be over-granted after apply`);
  }
  if (analysis.remainingAfterSimulation > 0) {
    failures.push(
      `plan does not converge: ${analysis.remainingAfterSimulation} ops remain after simulation`,
    );
  }
  if (analysis.largeRevoke.tripped && !context.allowLargeRevoke) {
    failures.push(
      `${analysis.largeRevoke.revokes} revokes exceed the alarm threshold ${analysis.largeRevoke.threshold}; review samples, then pass --allow-large-revoke`,
    );
  }

  return {
    format: RECEIPT_FORMAT,
    mode: context.mode,
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
}

/** Execute ops from a cursor, then re-read CourseBuilder and verify. */
export async function applyAndVerify(
  db: EggheadDatabase,
  railsExport: RailsAccessExport,
  ops: readonly DeltaOp[],
  cursor: ApplyCursor,
  options: ApplyRunOptions,
) {
  const finalCursor = await applyDeltaOps(db, ops, cursor, {
    batchSize: options.batchSize,
    ...(options.maxBatches === undefined ? {} : { maxBatches: options.maxBatches }),
    now: options.now,
    saveCursor: options.saveCursor,
  });
  const verify = await analyzeDatabase(
    db,
    railsExport,
    options.analysisNowMs,
    options.readOptions ?? DEFAULT_READ_OPTIONS,
  );
  return {
    cursor: finalCursor,
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
