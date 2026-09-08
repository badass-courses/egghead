import { z } from "zod";

import { teamInvitePayloadSchema, type TeamInvitePayload } from "./team-invite-token";

export const TEAM_INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const fieldsSchema = z.record(z.string(), z.unknown());
const invitationSchema = teamInvitePayloadSchema
  .extend({
    createdAt: z.number().int().nonnegative(),
    invitedByUserId: z.string().min(1),
    acceptedAt: z.number().int().nonnegative().optional(),
    acceptedByUserId: z.string().min(1).optional(),
    revokedAt: z.number().int().nonnegative().optional(),
  })
  .passthrough();
const invitationsSchema = z.record(z.string(), invitationSchema);

export type TeamInvitation = z.infer<typeof invitationSchema>;

type ParsedInvitationState = {
  fields: Record<string, unknown>;
  invitations: Record<string, TeamInvitation>;
};

function parseInvitationState(fields: unknown): ParsedInvitationState | null {
  const parsedFields = fieldsSchema.safeParse(fields);
  if (!parsedFields.success) return null;
  const invitations = invitationsSchema.safeParse(parsedFields.data["teamInvitations"] ?? {});
  if (!invitations.success) return null;
  return { fields: parsedFields.data, invitations: invitations.data };
}

export function teamInvitationStatus(invitation: TeamInvitation, now = Date.now()) {
  if (invitation.acceptedAt !== undefined || invitation.acceptedByUserId !== undefined) {
    return "accepted";
  }
  if (invitation.revokedAt !== undefined) return "revoked";
  return invitation.expiresAt <= now ? "expired" : "pending";
}

export function listTeamInvitations(fields: unknown, subscriptionId: string, ownerId: string) {
  const state = parseInvitationState(fields);
  if (!state || state.fields["ownerId"] !== ownerId) return [];
  return Object.entries(state.invitations)
    .filter(
      ([id, invitation]) =>
        id === invitation.invitationId && invitation.subscriptionId === subscriptionId,
    )
    .map(([, invitation]) => invitation)
    .toSorted((a, b) => b.createdAt - a.createdAt);
}

export function issueTeamInvitation(
  fields: unknown,
  payload: TeamInvitePayload,
  ownerId: string,
  now = Date.now(),
): Record<string, unknown> | null {
  const state = parseInvitationState(fields);
  const parsedPayload = teamInvitePayloadSchema.safeParse(payload);
  if (
    !state ||
    state.fields["ownerId"] !== ownerId ||
    !parsedPayload.success ||
    parsedPayload.data.expiresAt !== now + TEAM_INVITATION_LIFETIME_MS ||
    Object.hasOwn(state.invitations, parsedPayload.data.invitationId)
  )
    return null;

  return {
    ...state.fields,
    teamInvitations: {
      ...state.invitations,
      [parsedPayload.data.invitationId]: {
        ...parsedPayload.data,
        createdAt: now,
        invitedByUserId: ownerId,
      },
    },
  };
}

function pendingInvitationFromState(
  state: ParsedInvitationState | null,
  payload: TeamInvitePayload,
  now: number,
): TeamInvitation | null {
  const parsedPayload = teamInvitePayloadSchema.safeParse(payload);
  if (!state || !parsedPayload.success) return null;
  const signed = parsedPayload.data;
  const invitation = state.invitations[signed.invitationId];
  if (
    !invitation ||
    invitation.invitationId !== signed.invitationId ||
    invitation.subscriptionId !== signed.subscriptionId ||
    invitation.email !== signed.email ||
    invitation.expiresAt !== signed.expiresAt ||
    invitation.expiresAt !== invitation.createdAt + TEAM_INVITATION_LIFETIME_MS ||
    teamInvitationStatus(invitation, now) !== "pending"
  )
    return null;
  return invitation;
}

export function findPendingTeamInvitation(
  fields: unknown,
  payload: TeamInvitePayload,
  now = Date.now(),
): TeamInvitation | null {
  return pendingInvitationFromState(parseInvitationState(fields), payload, now);
}

export function consumeTeamInvitation(
  fields: unknown,
  payload: TeamInvitePayload,
  actor: { userId: string; email: string },
  now = Date.now(),
): Record<string, unknown> | null {
  const state = parseInvitationState(fields);
  const invitation = pendingInvitationFromState(state, payload, now);
  if (
    !state ||
    !invitation ||
    !actor.userId ||
    invitation.email !== actor.email.trim().toLowerCase()
  )
    return null;

  return {
    ...state.fields,
    teamInvitations: {
      ...state.invitations,
      [invitation.invitationId]: {
        ...invitation,
        acceptedAt: now,
        acceptedByUserId: actor.userId,
      },
    },
  };
}

export function revokeTeamInvitation(
  fields: unknown,
  input: { invitationId: string; subscriptionId: string; ownerId: string },
  now = Date.now(),
): Record<string, unknown> | null {
  const state = parseInvitationState(fields);
  if (!state || state.fields["ownerId"] !== input.ownerId) return null;
  const invitation = state.invitations[input.invitationId];
  if (
    !invitation ||
    invitation.invitationId !== input.invitationId ||
    invitation.subscriptionId !== input.subscriptionId ||
    teamInvitationStatus(invitation, now) !== "pending"
  )
    return null;

  return {
    ...state.fields,
    teamInvitations: {
      ...state.invitations,
      [invitation.invitationId]: { ...invitation, revokedAt: now },
    },
  };
}
