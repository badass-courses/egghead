import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { getEggheadDatabase } from "../db/adapter";
import { assertCommerceWritesAllowed } from "../db/local-docker";
import { subscription } from "../db/schema";
import { isTeamSubscription } from "./team-contracts";
import { createTeamInviteToken, type TeamInvitePayload } from "./team-invite-token";
import {
  findPendingTeamInvitation,
  issueTeamInvitation,
  listTeamInvitations,
  revokeTeamInvitation,
  TEAM_INVITATION_LIFETIME_MS,
} from "./team-invitation-state";

export async function issueOwnedTeamInvitation(input: {
  subscriptionId: string;
  ownerId: string;
  email: string;
}) {
  assertCommerceWritesAllowed();
  return getEggheadDatabase().transaction(async (transaction) => {
    const [row] = await transaction
      .select({ fields: subscription.fields, status: subscription.status })
      .from(subscription)
      .where(eq(subscription.id, input.subscriptionId))
      .for("update");
    if (!row || !isTeamSubscription(row.fields) || !["active", "trialing"].includes(row.status)) {
      return null;
    }

    const now = Date.now();
    const payload: TeamInvitePayload = {
      invitationId: randomUUID(),
      subscriptionId: input.subscriptionId,
      email: input.email.trim().toLowerCase(),
      expiresAt: now + TEAM_INVITATION_LIFETIME_MS,
    };
    const fields = issueTeamInvitation(row.fields, payload, input.ownerId, now);
    if (!fields) return null;
    const token = createTeamInviteToken(payload);
    await transaction
      .update(subscription)
      .set({ fields })
      .where(eq(subscription.id, input.subscriptionId));
    return { payload, token };
  });
}

export async function listOwnedTeamInvitations(input: { subscriptionId: string; ownerId: string }) {
  return getEggheadDatabase().transaction(async (transaction) => {
    const [row] = await transaction
      .select({ fields: subscription.fields })
      .from(subscription)
      .where(eq(subscription.id, input.subscriptionId))
      .for("update");
    if (!row || !isTeamSubscription(row.fields)) return [];
    return listTeamInvitations(row.fields, input.subscriptionId, input.ownerId);
  });
}

export async function revokeOwnedTeamInvitation(input: {
  subscriptionId: string;
  ownerId: string;
  invitationId: string;
}) {
  assertCommerceWritesAllowed();
  return getEggheadDatabase().transaction(async (transaction) => {
    const [row] = await transaction
      .select({ fields: subscription.fields })
      .from(subscription)
      .where(eq(subscription.id, input.subscriptionId))
      .for("update");
    if (!row || !isTeamSubscription(row.fields)) return false;
    const fields = revokeTeamInvitation(row.fields, input);
    if (!fields) return false;
    await transaction
      .update(subscription)
      .set({ fields })
      .where(eq(subscription.id, input.subscriptionId));
    return true;
  });
}

// Display-only preflight. Acceptance rechecks and consumes under the seat transaction's row lock.
export async function isPersistedTeamInvitationPending(payload: TeamInvitePayload) {
  const row = await getEggheadDatabase().query.subscription.findFirst({
    columns: { fields: true },
    where: eq(subscription.id, payload.subscriptionId),
  });
  return Boolean(
    row && isTeamSubscription(row.fields) && findPendingTeamInvitation(row.fields, payload),
  );
}
