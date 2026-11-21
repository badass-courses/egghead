// Plan and cursor files for `access-delta --apply` / `--resume`.
//
// The plan holds customer emails and names (user_create ops). It stays in the
// desk's local working directory with mode 0600; never copy it into Brain.

import { createHash } from "node:crypto";

import { z } from "zod";

import type { DeltaOp } from "./rails-access-delta";
import { undoRowSchema, type UndoRow } from "./rails-access-delta-rollback";

export const PLAN_FORMAT = "egghead-access-delta-plan/v7";
export const CURSOR_FORMAT = "egghead-access-delta-cursor/v1";

const jsonRecord = z.record(z.string(), z.unknown());
const iso = z.string().nullable();

const newUser = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.string(),
  fields: jsonRecord,
  emailVerified: iso,
  image: z.string().nullable(),
  createdAt: iso,
});

const newOrganization = z.object({
  id: z.string(),
  name: z.string(),
  fields: jsonRecord,
  createdAt: iso,
});

const membership = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  invitedById: z.string(),
  role: z.string(),
  fields: jsonRecord,
  createdAt: iso,
});

const entitlement = z.object({
  id: z.string(),
  entitlementType: z.string(),
  userId: z.string().nullable(),
  organizationId: z.string().nullable(),
  organizationMembershipId: z.string().nullable(),
  sourceType: z.string(),
  sourceId: z.string(),
  metadata: jsonRecord,
  expiresAt: iso,
  createdAt: iso,
});

const reasons = z.array(z.string());

const deltaOp = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user_create"),
    key: z.string(),
    railsUserId: z.string(),
    user: newUser,
  }),
  z.object({
    kind: z.literal("user_link"),
    key: z.string(),
    userId: z.string(),
    railsUserId: z.string(),
  }),
  z.object({
    kind: z.literal("user_email_update"),
    key: z.string(),
    userId: z.string(),
    railsUserId: z.string(),
    email: z.string(),
    previousEmail: z.string(),
  }),
  z.object({
    kind: z.literal("organization_create"),
    key: z.string(),
    organization: newOrganization,
  }),
  z.object({ kind: z.literal("membership_create"), key: z.string(), membership, reasons }),
  z.object({ kind: z.literal("membership_update"), key: z.string(), membership, reasons }),
  z.object({ kind: z.literal("membership_revoke"), key: z.string(), membershipId: z.string() }),
  z.object({ kind: z.literal("entitlement_grant"), key: z.string(), entitlement, reasons }),
  z.object({ kind: z.literal("entitlement_extend"), key: z.string(), entitlement, reasons }),
  z.object({ kind: z.literal("entitlement_update"), key: z.string(), entitlement, reasons }),
  z.object({ kind: z.literal("entitlement_revoke"), key: z.string(), entitlementId: z.string() }),
  z.object({ kind: z.literal("entitlement_expire"), key: z.string(), entitlementId: z.string() }),
]);

/**
 * Every flag that changes the gate's verdict or the plan. The dry run records
 * them; `--apply` and `--resume` refuse unless they pass the same values.
 */
const gateInputsSchema = z.object({
  allowLargeRevoke: z.boolean(),
  /** sha256 of the accepted bare-`pro` Rails id list. */
  acceptBarePro: z.string().nullable(),
  /** sha256 of the accepted held legacy-subscription id list. */
  acceptStaleLegacy: z.string().nullable(),
  acceptStaleManaged: z.string().nullable(),
  /** sha256 of the accepted orphan Rails user id list (their rows are revoked). */
  acceptOrphanGrants: z.string().nullable(),
  /** sha256 of the accepted held-organization reach list. */
  acceptHeldOrgReach: z.string().nullable(),
  /** First-run backing counts a person accepted, per source type. */
  acceptFirstBacking: z.record(z.string(), z.number().int().nonnegative()),
  /** sha256 of the `--previous-receipt` file's bytes. */
  previousReceiptSha256: z.string().nullable(),
  allowBackingGrowth: z.boolean(),
  /** `--held-seat-flag` rulings by membership id. */
  seatFlagRulings: z.record(z.string(), z.enum(["clear", "keep"])),
  maxIdentityOps: z.number().int().nonnegative(),
  legacyStaleDays: z.number().int().positive(),
  bareProActiveDays: z.number().int().nonnegative(),
});

export type GateInputs = z.infer<typeof gateInputsSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Names of the gate inputs that differ (key order inside records ignored). */
export function gateInputsDiff(reviewed: GateInputs, now: GateInputs): string[] {
  const fields = Object.keys(gateInputsSchema.shape).filter(
    (field): field is keyof GateInputs => field in reviewed,
  );
  return fields.filter((field) => canonical(reviewed[field]) !== canonical(now[field]));
}

const planFile = z.object({
  format: z.literal(PLAN_FORMAT),
  exportSha256: z.string(),
  database: z.string(),
  /** sha256 of the database host: binds the plan without storing the host. */
  hostSha256: z.string(),
  /**
   * sha256 of the database user. A PlanetScale branch and its production
   * share a host; each branch password has its own user, so this binds the
   * plan to the branch it was reviewed on.
   */
  databaseUserSha256: z.string(),
  /** `identity` plans hold only email updates and links (see --identity-pass). */
  pass: z.enum(["full", "identity"]),
  /** The gate inputs the plan was reviewed with; apply and resume must pass the same. */
  gateInputs: gateInputsSchema,
  generatedAt: z.string(),
  planSha256: z.string(),
  ops: z.array(deltaOp),
  undoRows: z.array(undoRowSchema).optional(),
  onlyUsers: z.array(z.string()).optional(),
  runtime: z.string().optional(),
});

const cursorFile = z.object({
  format: z.literal(CURSOR_FORMAT),
  exportSha256: z.string(),
  database: z.string(),
  planSha256: z.string(),
  totalOps: z.number().int().nonnegative(),
  appliedOps: z.number().int().nonnegative(),
  batches: z.number().int().nonnegative(),
  lastKey: z.string().nullable(),
  complete: z.boolean(),
  updatedAt: z.string(),
  undoRows: z.array(undoRowSchema).optional(),
});

export type DeltaPlanFile = Omit<z.infer<typeof planFile>, "ops"> & {
  readonly ops: readonly DeltaOp[];
};
export type ApplyCursor = z.infer<typeof cursorFile>;

export function hostSha256(host: string) {
  return createHash("sha256").update(host.trim().toLowerCase()).digest("hex");
}

/** Case kept: MySQL user names are case-sensitive. */
export function databaseUserSha256(user: string) {
  return createHash("sha256").update(user).digest("hex");
}

export function planSha256(ops: readonly DeltaOp[]) {
  return createHash("sha256").update(JSON.stringify(ops)).digest("hex");
}

export function serializePlan(input: {
  exportSha256: string;
  database: string;
  hostSha256: string;
  databaseUserSha256: string;
  pass: "full" | "identity";
  gateInputs: GateInputs;
  generatedAt: string;
  ops: readonly DeltaOp[];
  undoRows?: readonly UndoRow[];
  onlyUsers?: string[];
  runtime?: string;
}): string {
  const file: DeltaPlanFile = {
    format: PLAN_FORMAT,
    exportSha256: input.exportSha256,
    database: input.database,
    hostSha256: input.hostSha256,
    databaseUserSha256: input.databaseUserSha256,
    pass: input.pass,
    gateInputs: input.gateInputs,
    generatedAt: input.generatedAt,
    planSha256: planSha256(input.ops),
    ops: input.ops,
    ...(input.undoRows ? { undoRows: [...input.undoRows] } : {}),
    ...(input.onlyUsers ? { onlyUsers: input.onlyUsers } : {}),
    ...(input.runtime ? { runtime: input.runtime } : {}),
  };
  return `${JSON.stringify(file)}\n`;
}

export function parsePlan(text: string): DeltaPlanFile {
  const file = planFile.parse(JSON.parse(text));
  if (planSha256(file.ops) !== file.planSha256) {
    throw new Error("plan file ops do not match its planSha256; refusing to resume");
  }
  return file;
}

export function parseCursor(text: string): ApplyCursor {
  return cursorFile.parse(JSON.parse(text));
}

export function newCursor(
  plan: Pick<DeltaPlanFile, "exportSha256" | "database" | "planSha256" | "ops">,
  now: string,
): ApplyCursor {
  return {
    format: CURSOR_FORMAT,
    exportSha256: plan.exportSha256,
    database: plan.database,
    planSha256: plan.planSha256,
    totalOps: plan.ops.length,
    appliedOps: 0,
    batches: 0,
    lastKey: null,
    complete: plan.ops.length === 0,
    updatedAt: now,
  };
}
