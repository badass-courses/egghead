"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getCurrentUser } from "../../coursebuilder/current-user";
import { sendEmail } from "../../coursebuilder/email-delivery";
import { getSiteUrl } from "../../coursebuilder/stripe-provider";
import { assertLocalDockerDatabaseUrl } from "../../db/local-docker";
import { getEnv } from "../../env";
import { getSubscriptionStore } from "../../subscriptions/store";
import { subscriptionCheckoutQuantitySchema } from "../../subscriptions/team-contracts";
import {
  getOwnedTeamSubscription,
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
  assertLocalDockerDatabaseUrl();

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

  const result = await grantTeamSubscriptionSeat({
    ownerId: inviteDetails.ownerId,
    seatUserId: currentUser.id,
    subscriptionId: payload.subscriptionId,
  });

  if (result.status === "already-assigned") redirect("/profile?team=already-member");
  if (result.status === "full") redirect(`${invitePath}?status=claimed`);
  if (result.status === "not-found") redirect(`${invitePath}?error=unavailable`);

  refreshTeamPages();
  redirect("/profile?team=joined");
}

export async function claimTeamSeat(formData: FormData) {
  assertLocalDockerDatabaseUrl();

  const currentUser = await getCurrentUser();
  if (!currentUser?.id) redirect("/login?callbackUrl=%2Fteam");

  const subscriptionId = subscriptionIdSchema.safeParse(formData.get("subscriptionId"));
  if (!subscriptionId.success) redirect("/team?error=team-unavailable");

  const result = await grantTeamSubscriptionSeat({
    ownerId: currentUser.id,
    seatUserId: currentUser.id,
    subscriptionId: subscriptionId.data,
  });
  if (result.status !== "assigned") {
    redirect(`/team?error=${teamActionError(result.status)}`);
  }

  refreshTeamPages();
  redirect("/team?notice=seat-claimed");
}

export async function inviteTeamMember(formData: FormData) {
  assertLocalDockerDatabaseUrl();

  const currentUser = await getCurrentUser();
  if (!currentUser?.id) redirect("/login?callbackUrl=%2Fteam");

  const subscriptionId = subscriptionIdSchema.safeParse(formData.get("subscriptionId"));
  const email = inviteEmailSchema.safeParse(formData.get("email"));
  if (!subscriptionId.success || !email.success) redirect("/team?error=invalid-invite");

  const [ownedTeam, inviteDetails] = await Promise.all([
    getOwnedTeamSubscription(currentUser.id),
    getTeamInviteDetails(subscriptionId.data),
  ]);
  if (!ownedTeam || ownedTeam.id !== subscriptionId.data || !inviteDetails)
    redirect("/team?error=team-unavailable");
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
  assertLocalDockerDatabaseUrl();

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

export async function prepareTeamSeatReduction(formData: FormData) {
  assertLocalDockerDatabaseUrl();
  const user = await getCurrentUser();
  if (!user?.id) redirect("/login?callbackUrl=%2Fteam");
  const selection = z
    .object({
      subscriptionId: subscriptionIdSchema,
      seats: subscriptionCheckoutQuantitySchema,
      retainedUserIds: z.array(userIdSchema).max(100),
    })
    .safeParse({
      subscriptionId: formData.get("subscriptionId"),
      seats: formData.get("seats"),
      retainedUserIds: formData.getAll("retainedUserIds"),
    });
  if (!selection.success) redirect("/team?error=invalid-selection");
  const result = await getSubscriptionStore().prepareReduction({
    ...selection.data,
    ownerId: user.id,
  });
  if (result.status !== "prepared") redirect("/team?error=invalid-selection");
  refreshTeamPages();
  redirect("/team?notice=reduction-prepared");
}
