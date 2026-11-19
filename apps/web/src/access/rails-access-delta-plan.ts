// Plan and cursor files for `access-delta --apply` / `--resume`.
//
// The plan holds customer emails and names (user_create ops). It stays in the
// desk's local working directory with mode 0600; never copy it into Brain.

import { createHash } from "node:crypto";

import { z } from "zod";

import type { DeltaOp } from "./rails-access-delta";

export const PLAN_FORMAT = "egghead-access-delta-plan/v1";
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

const planFile = z.object({
  format: z.literal(PLAN_FORMAT),
  exportSha256: z.string(),
  database: z.string(),
  generatedAt: z.string(),
  planSha256: z.string(),
  ops: z.array(deltaOp),
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
});

export type DeltaPlanFile = Omit<z.infer<typeof planFile>, "ops"> & {
  readonly ops: readonly DeltaOp[];
};
export type ApplyCursor = z.infer<typeof cursorFile>;

export function planSha256(ops: readonly DeltaOp[]) {
  return createHash("sha256").update(JSON.stringify(ops)).digest("hex");
}

export function serializePlan(input: {
  exportSha256: string;
  database: string;
  generatedAt: string;
  ops: readonly DeltaOp[];
}): string {
  const file: DeltaPlanFile = {
    format: PLAN_FORMAT,
    exportSha256: input.exportSha256,
    database: input.database,
    generatedAt: input.generatedAt,
    planSha256: planSha256(input.ops),
    ops: input.ops,
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
