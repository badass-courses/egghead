"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getCurrentUser } from "../../coursebuilder/current-user";
import { sendEmail } from "../../coursebuilder/email-delivery";
import { getSiteUrl } from "../../coursebuilder/stripe-provider";
import { assertCommerceWritesAllowed } from "../../db/local-docker";
import { getEnv } from "../../env";
import {
  getOwnedTeamSubscriptionRow,
  getTeamInviteDetails,
  grantTeamSubscriptionSeat,
  removeTeamSubscriptionSeat,
} from "../../subscriptions/team";
import {
  teamInviteMatchesEmail,
  verifyTeamInviteToken,
} from "../../subscriptions/team-invite-token";
import {
  issueOwnedTeamInvitation,
  revokeOwnedTeamInvitation,
} from "../../subscriptions/team-invitations";

const subscriptionIdSchema = z.string().min(1).max(191);
const userIdSchema = z.string().min(1).max(255);
const inviteEmailSchema = z
  .string()
  .trim()
  .email()
  .max(255)
  .transform((email) => email.toLowerCase());

function refreshTeamPages() {
  revalidatePath("/profile");
  revalidatePath("/team");
  revalidatePath("/thanks/subscription");
}

function teamActionError(status: "already-assigned" | "full" | "not-found" | "invalid-invite") {
  if (status === "already-assigned") return "already-assigned";
  if (status === "full") return "team-full";
  return "team-unavailable";
}

function teamInvitePath(token: string) {
  return `/team/invite/${encodeURIComponent(token)}`;
}

export async function acceptTeamInvite(formData: FormData) {
  assertCommerceWritesAllowed();

  const token = formData.get("token");
  if (typeof token !== "string") redirect("/team");

  const invitePath = teamInvitePath(token);
  const payload = verifyTeamInviteToken(token);
  if (!payload) redirect("/team");

  const currentUser = await getCurrentUser();
  if (!currentUser?.id) {
    const loginParams = new URLSearchParams({ callbackUrl: invitePath });
    redirect(`/login?${loginParams.toString()}`);
  }

  if (!teamInviteMatchesEmail(payload, currentUser.email ?? "")) {
    redirect(`${invitePath}?error=email-mismatch`);
  }

  const inviteDetails = await getTeamInviteDetails(payload.subscriptionId);
  if (!inviteDetails) redirect(`${invitePath}?error=unavailable`);
  if (inviteDetails.availableSeats === 0) redirect(`${invitePath}?status=claimed`);

  const ownedSubscription = await getOwnedTeamSubscriptionRow(
    payload.subscriptionId,
    inviteDetails.ownerId,
  );
  if (!ownedSubscription) redirect(`${invitePath}?error=unavailable`);

  const result = await grantTeamSubscriptionSeat({
    invitation: payload,
    ownerId: inviteDetails.ownerId,
    seatUserId: currentUser.id,
    stripeSubscriptionId: ownedSubscription.stripeSubscriptionId,
    subscriptionId: payload.subscriptionId,
  });

  if (result.status === "already-assigned") redirect("/profile?team=already-member");
  if (result.status === "full") redirect(`${invitePath}?status=claimed`);
  if (result.status === "not-found") redirect(`${invitePath}?error=unavailable`);
  if (result.status === "invalid-invite") redirect(`${invitePath}?error=invalid-invite`);

  refreshTeamPages();
  redirect("/profile?team=joined");
}

export async function claimTeamSeat(formData: FormData) {
  assertCommerceWritesAllowed();

  const currentUser = await getCurrentUser();
  if (!currentUser?.id) redirect("/login?callbackUrl=%2Fteam");

  const subscriptionId = subscriptionIdSchema.safeParse(formData.get("subscriptionId"));
  if (!subscriptionId.success) redirect("/team?error=team-unavailable");

  const ownedSubscription = await getOwnedTeamSubscriptionRow(subscriptionId.data, currentUser.id);
  if (!ownedSubscription) redirect("/team?error=team-unavailable");

  const result = await grantTeamSubscriptionSeat({
    ownerId: currentUser.id,
    seatUserId: currentUser.id,
    stripeSubscriptionId: ownedSubscription.stripeSubscriptionId,
    subscriptionId: subscriptionId.data,
  });
  if (result.status !== "assigned") {
    redirect(`/team?error=${teamActionError(result.status)}`);
  }

  refreshTeamPages();
  redirect("/team?notice=seat-claimed");
}

export async function inviteTeamMember(formData: FormData) {
  assertCommerceWritesAllowed();

  const currentUser = await getCurrentUser();
  if (!currentUser?.id) redirect("/login?callbackUrl=%2Fteam");

  const subscriptionId = subscriptionIdSchema.safeParse(formData.get("subscriptionId"));
  const email = inviteEmailSchema.safeParse(formData.get("email"));
  if (!subscriptionId.success || !email.success) redirect("/team?error=invalid-invite");

  const [ownedSubscription, inviteDetails] = await Promise.all([
    getOwnedTeamSubscriptionRow(subscriptionId.data, currentUser.id),
    getTeamInviteDetails(subscriptionId.data),
  ]);
  if (!ownedSubscription || !inviteDetails) redirect("/team?error=team-unavailable");
  if (inviteDetails.availableSeats === 0) redirect("/team?error=team-full");

  const invitation = await issueOwnedTeamInvitation({
    subscriptionId: subscriptionId.data,
    ownerId: currentUser.id,
    email: email.data,
  });
  if (!invitation) redirect("/team?error=team-unavailable");
  const inviteUrl = new URL(`/team/invite/${invitation.token}`, getSiteUrl()).toString();

  try {
    await sendEmail(
      {
        from: getEnv("POSTMARK_FROM_EMAIL") ?? "egghead development <no-reply@egghead.local>",
        to: email.data,
        subject: "Join your egghead team",
        text: `You've been invited to an egghead team membership. This email-scoped invitation expires in 7 days and can be used once. Sign in with this email address and accept your seat: ${inviteUrl}`,
        html: `<p>You've been invited to an egghead team membership.</p><p><a href="${inviteUrl}">Accept your team seat</a></p><p>Sign in with the email address that received this invitation. It expires in 7 days and can be used once.</p>`,
      },
      { apiKey: getEnv("POSTMARK_API_KEY") },
    );
  } catch {
    redirect("/team?error=invite-email-failed");
  }

  refreshTeamPages();
  redirect("/team?notice=invite-sent");
}

export async function removeTeamMember(formData: FormData) {
  assertCommerceWritesAllowed();

  const currentUser = await getCurrentUser();
  if (!currentUser?.id) redirect("/login?callbackUrl=%2Fteam");

  const subscriptionId = subscriptionIdSchema.safeParse(formData.get("subscriptionId"));
  const userId = userIdSchema.safeParse(formData.get("userId"));
  if (!subscriptionId.success || !userId.success) redirect("/team?error=team-unavailable");

  const result = await removeTeamSubscriptionSeat({
    ownerId: currentUser.id,
    subscriptionId: subscriptionId.data,
    userId: userId.data,
  });
  if (result.status !== "removed") redirect("/team?error=team-unavailable");

  refreshTeamPages();
  redirect("/team?notice=seat-removed");
}

export async function revokeTeamMemberInvitation(formData: FormData) {
  assertCommerceWritesAllowed();
  const currentUser = await getCurrentUser();
  if (!currentUser?.id) redirect("/login?callbackUrl=%2Fteam");
  const subscriptionId = subscriptionIdSchema.safeParse(formData.get("subscriptionId"));
  const invitationId = z.string().min(1).max(191).safeParse(formData.get("invitationId"));
  if (!subscriptionId.success || !invitationId.success) redirect("/team?error=invalid-invite");
  const revoked = await revokeOwnedTeamInvitation({
    subscriptionId: subscriptionId.data,
    invitationId: invitationId.data,
    ownerId: currentUser.id,
  });
  if (!revoked) redirect("/team?error=invitation-unavailable");
  refreshTeamPages();
  redirect("/team?notice=invite-revoked");
}
