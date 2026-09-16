"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getCurrentUser } from "../../coursebuilder/current-user";
import { sendEmail } from "../../coursebuilder/email-delivery";
import { getSiteUrl, getStripeProvider } from "../../coursebuilder/stripe-provider";
import { assertCommerceWritesAllowed } from "../../db/local-docker";
import { getEnv } from "../../env";
import { stripeSubscriptionGrantsAccess } from "../../subscriptions/access";
import { getStripeSubscriptionCurrentPeriodEnd } from "../../subscriptions/stripe";
import {
  getOwnedTeamSubscriptionRow,
  getTeamInviteDetails,
  grantTeamSubscriptionSeat,
  removeTeamSubscriptionSeat,
} from "../../subscriptions/team";
import {
  createTeamInviteToken,
  teamInviteMatchesEmail,
  verifyTeamInviteToken,
} from "../../subscriptions/team-invite-token";

const subscriptionIdSchema = z.string().min(1).max(191);
const userIdSchema = z.string().min(1).max(255);
const inviteEmailSchema = z
  .string()
  .trim()
  .email()
  .max(255)
  .transform((email) => email.toLowerCase());

async function getTeamStripeState(subscriptionId: string, ownerId: string) {
  const ownedSubscription = await getOwnedTeamSubscriptionRow(subscriptionId, ownerId);
  const stripeProvider = getStripeProvider();
  if (!ownedSubscription || !stripeProvider) return null;

  const stripeSubscription = await stripeProvider.options.paymentsAdapter.getSubscription(
    ownedSubscription.stripeSubscriptionId,
  );
  const currentPeriodEnd = getStripeSubscriptionCurrentPeriodEnd(stripeSubscription);
  if (!currentPeriodEnd || !stripeSubscriptionGrantsAccess(stripeSubscription.status)) return null;

  return {
    currentPeriodEnd: new Date(currentPeriodEnd * 1000),
    ownedSubscription,
    status: stripeSubscription.status,
  };
}

function refreshTeamPages() {
  revalidatePath("/profile");
  revalidatePath("/team");
  revalidatePath("/thanks/subscription");
}

function teamActionError(status: "already-assigned" | "full" | "not-found") {
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

  const teamState = await getTeamStripeState(payload.subscriptionId, inviteDetails.ownerId);
  if (!teamState) redirect(`${invitePath}?error=unavailable`);

  const result = await grantTeamSubscriptionSeat({
    currentPeriodEnd: teamState.currentPeriodEnd,
    ownerId: inviteDetails.ownerId,
    seatUserId: currentUser.id,
    status: teamState.status,
    stripeSubscriptionId: teamState.ownedSubscription.stripeSubscriptionId,
    subscriptionId: payload.subscriptionId,
  });

  if (result.status === "already-assigned") redirect("/profile?team=already-member");
  if (result.status === "full") redirect(`${invitePath}?status=claimed`);
  if (result.status === "not-found") redirect(`${invitePath}?error=unavailable`);

  refreshTeamPages();
  redirect("/profile?team=joined");
}

export async function claimTeamSeat(formData: FormData) {
  assertCommerceWritesAllowed();

  const currentUser = await getCurrentUser();
  if (!currentUser?.id) redirect("/login?callbackUrl=%2Fteam");

  const subscriptionId = subscriptionIdSchema.safeParse(formData.get("subscriptionId"));
  if (!subscriptionId.success) redirect("/team?error=team-unavailable");

  const teamState = await getTeamStripeState(subscriptionId.data, currentUser.id);
  if (!teamState) redirect("/team?error=team-unavailable");

  const result = await grantTeamSubscriptionSeat({
    currentPeriodEnd: teamState.currentPeriodEnd,
    ownerId: currentUser.id,
    seatUserId: currentUser.id,
    status: teamState.status,
    stripeSubscriptionId: teamState.ownedSubscription.stripeSubscriptionId,
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

  const [teamState, inviteDetails] = await Promise.all([
    getTeamStripeState(subscriptionId.data, currentUser.id),
    getTeamInviteDetails(subscriptionId.data),
  ]);
  if (!teamState || !inviteDetails) redirect("/team?error=team-unavailable");
  if (inviteDetails.availableSeats === 0) redirect("/team?error=team-full");

  const token = createTeamInviteToken(subscriptionId.data, email.data);
  const inviteUrl = new URL(`/team/invite/${token}`, getSiteUrl()).toString();

  try {
    await sendEmail(
      {
        from: getEnv("POSTMARK_FROM_EMAIL") ?? "egghead development <no-reply@egghead.local>",
        to: email.data,
        subject: "Join your egghead team",
        text: `You've been invited to an egghead team membership. Sign in with this email address and accept your seat: ${inviteUrl}`,
        html: `<p>You've been invited to an egghead team membership.</p><p><a href="${inviteUrl}">Accept your team seat</a></p><p>Sign in with the email address that received this invitation.</p>`,
      },
      { apiKey: getEnv("POSTMARK_API_KEY") },
    );
  } catch {
    redirect("/team?error=invite-email-failed");
  }

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
