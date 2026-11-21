import type { CbSnapshot, DeltaOp } from "./rails-access-delta";

/** Canary selection never clips a shared organization: include its whole team. */
export function selectUserOps(
  ops: readonly DeltaOp[],
  snapshot: CbSnapshot,
  onlyUsers: readonly string[] | undefined,
): readonly DeltaOp[] {
  if (!onlyUsers) return ops;
  if (onlyUsers.length === 0) throw new Error("--only-users must contain Rails user ids");
  const wanted = new Set(onlyUsers);
  const railsByCb = new Map(snapshot.users.map((row) => [row.id, row.legacyRailsUserId]));
  for (const op of ops) {
    if (op.kind === "user_create") railsByCb.set(op.user.id, op.railsUserId);
    if (op.kind === "user_link") railsByCb.set(op.userId, op.railsUserId);
  }
  const members = new Map(snapshot.memberships.map((row) => [row.id, row]));
  for (const op of ops)
    if (op.kind === "membership_create" || op.kind === "membership_update")
      members.set(op.membership.id, op.membership);
  const entitlements = new Map(snapshot.entitlements.map((row) => [row.id, row]));
  const selectedCb = (id: string | null) => id !== null && wanted.has(railsByCb.get(id) ?? "");
  const selectedOrg = (id: string | null) => {
    if (id === null) return false;
    const team = [...members.values()].filter((row) => row.organizationId === id);
    const chosen = team.filter((row) => selectedCb(row.userId));
    if (chosen.length > 0 && chosen.length !== team.length)
      throw new Error(
        "--only-users reaches a shared organization; include every Rails member or choose individual users",
      );
    return chosen.length > 0;
  };
  const assertMoveScope = (
    previous: { userId: string | null; organizationId: string | null } | undefined,
    next: { userId: string | null; organizationId: string | null },
  ) => {
    if (!previous) return;
    const before = selectedCb(previous.userId) || selectedOrg(previous.organizationId);
    const after = selectedCb(next.userId) || selectedOrg(next.organizationId);
    if (before !== after)
      throw new Error("--only-users cannot move access across the selected-user boundary");
  };
  return ops.filter((op) => {
    switch (op.kind) {
      case "user_create":
      case "user_link":
      case "user_email_update":
        return wanted.has(op.railsUserId);
      case "organization_create":
        return selectedOrg(op.organization.id);
      case "membership_create":
      case "membership_update":
        assertMoveScope(
          snapshot.memberships.find((row) => row.id === op.membership.id),
          op.membership,
        );
        selectedOrg(op.membership.organizationId);
        return selectedCb(op.membership.userId);
      case "membership_revoke": {
        const row = members.get(op.membershipId);
        if (!row) throw new Error("canary membership target missing");
        selectedOrg(row.organizationId);
        return selectedCb(row.userId);
      }
      case "entitlement_grant":
      case "entitlement_extend":
      case "entitlement_update":
        assertMoveScope(entitlements.get(op.entitlement.id), op.entitlement);
        return selectedCb(op.entitlement.userId) || selectedOrg(op.entitlement.organizationId);
      case "entitlement_revoke":
      case "entitlement_expire": {
        const row = entitlements.get(op.entitlementId);
        if (!row) throw new Error("canary entitlement target missing");
        return selectedCb(row.userId) || selectedOrg(row.organizationId);
      }
      default:
        throw new Error("Unknown delta operation");
    }
  });
}
export function parseOnlyUsers(text: string): string[] {
  const ids = [...new Set(text.trim().split(/\s+/))].toSorted();
  if (ids.length === 0 || ids.some((id) => !/^\d+$/.test(id)))
    throw new Error("--only-users needs a nonempty whitespace-separated file of Rails user ids");
  return ids;
}
