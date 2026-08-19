"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getCurrentUser } from "../../coursebuilder/current-user";
import { sendEmail } from "../../coursebuilder/email-delivery";
import { getSiteUrl, getStripeProvider } from "../../coursebuilder/stripe-provider";
import { getCourseBuilderAdapter, getEggheadDatabase } from "../../db/adapter";
import { assertCommerceWritesAllowed } from "../../db/local-docker";
import { subscription } from "../../db/schema";
import { getEnv } from "../../env";
import { stripeSubscriptionGrantsAccess } from "../../subscriptions/access";
import {
  getStripeSubscriptionCurrentPeriodEnd,
  getStripeSubscriptionQuantity,
} from "../../subscriptions/stripe";
import {
  getOwnedTeamSubscriptionRow,
  grantTeamSubscriptionSeat,
  removeTeamSubscriptionSeat,
} from "../../subscriptions/team";
import {
  MAX_TEAM_SEATS,
  mergeTeamSubscriptionFields,
  subscriptionCheckoutQuantitySchema,
  teamSubscriptionFieldsSchema,
} from "../../subscriptions/team-contracts";

const subscriptionIdSchema = z.string().min(1).max(191);
const userIdSchema = z.string().min(1).max(255);
const inviteEmailSchema = z
  .string()
  .trim()
  .email()
  .max(255)
  .transform((email) => email.toLowerCase());
const additionalSeatsSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_TEAM_SEATS - 1);

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
    stripeSubscription,
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

async function sendTeamSeatEmail(email: string) {
  const loginUrl = new URL("/login?callbackUrl=%2Fteam", getSiteUrl()).toString();
  return sendEmail(
    {
      from: getEnv("POSTMARK_FROM_EMAIL") ?? "egghead development <no-reply@egghead.local>",
      to: email,
      subject: "Your egghead team seat is ready",
      text: `You've been added to an egghead team membership. Sign in with this email address to start learning: ${loginUrl}`,
      html: `<p>You've been added to an egghead team membership.</p><p><a href="${loginUrl}">Sign in to start learning</a></p>`,
    },
    { apiKey: getEnv("POSTMARK_API_KEY") },
  );
}

export async function inviteTeamMember(formData: FormData) {
  assertCommerceWritesAllowed();

  const currentUser = await getCurrentUser();
  if (!currentUser?.id) redirect("/login?callbackUrl=%2Fteam");

  const subscriptionId = subscriptionIdSchema.safeParse(formData.get("subscriptionId"));
  const email = inviteEmailSchema.safeParse(formData.get("email"));
  if (!subscriptionId.success || !email.success) redirect("/team?error=invalid-invite");

  const teamState = await getTeamStripeState(subscriptionId.data, currentUser.id);
  if (!teamState) redirect("/team?error=team-unavailable");

  const invitedUser = await getCourseBuilderAdapter().findOrCreateUser(email.data);
  const result = await grantTeamSubscriptionSeat({
    currentPeriodEnd: teamState.currentPeriodEnd,
    ownerId: currentUser.id,
    seatUserId: invitedUser.user.id,
    status: teamState.status,
    stripeSubscriptionId: teamState.ownedSubscription.stripeSubscriptionId,
    subscriptionId: subscriptionId.data,
  });
  if (result.status !== "assigned") {
    redirect(`/team?error=${teamActionError(result.status)}`);
  }

  refreshTeamPages();
  try {
    await sendTeamSeatEmail(email.data);
  } catch {
    redirect("/team?notice=invited-email-delayed");
  }
  redirect("/team?notice=invited");
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

export async function addTeamSeats(formData: FormData) {
  assertCommerceWritesAllowed();

  const currentUser = await getCurrentUser();
  if (!currentUser?.id) redirect("/login?callbackUrl=%2Fteam");

  const subscriptionId = subscriptionIdSchema.safeParse(formData.get("subscriptionId"));
  const additionalSeats = additionalSeatsSchema.safeParse(formData.get("additionalSeats"));
  if (!subscriptionId.success || !additionalSeats.success) {
    redirect("/team?error=invalid-seat-count");
  }

  const teamState = await getTeamStripeState(subscriptionId.data, currentUser.id);
  const stripeProvider = getStripeProvider();
  if (!teamState || !stripeProvider) redirect("/team?error=team-unavailable");

  const stripeQuantity = subscriptionCheckoutQuantitySchema.safeParse(
    getStripeSubscriptionQuantity(teamState.stripeSubscription),
  );
  if (!stripeQuantity.success) redirect("/team?error=invalid-seat-count");

  const seatUpdate = await getEggheadDatabase().transaction(async (transaction) => {
    const [storedSubscription] = await transaction
      .select({ fields: subscription.fields })
      .from(subscription)
      .where(eq(subscription.id, subscriptionId.data))
      .for("update");
    const storedFields = teamSubscriptionFieldsSchema.safeParse(storedSubscription?.fields);
    if (!storedFields.success || storedFields.data.ownerId !== currentUser.id) {
      return "unavailable" as const;
    }

    // The row lock serializes local seat additions. Stripe may be ahead while a
    // webhook is converging, so never calculate from a lower local quantity.
    const currentQuantity = Math.max(storedFields.data.seats, stripeQuantity.data);
    const nextQuantity = currentQuantity + additionalSeats.data;
    if (nextQuantity > MAX_TEAM_SEATS) return "invalid" as const;

    await stripeProvider.options.paymentsAdapter.updateSubscriptionItemQuantity(
      teamState.ownedSubscription.stripeSubscriptionId,
      nextQuantity,
    );
    await transaction
      .update(subscription)
      .set({
        fields: mergeTeamSubscriptionFields(storedSubscription?.fields, {
          ownerId: currentUser.id,
          seats: nextQuantity,
        }),
      })
      .where(eq(subscription.id, subscriptionId.data));

    return "updated" as const;
  });
  if (seatUpdate === "unavailable") redirect("/team?error=team-unavailable");
  if (seatUpdate === "invalid") redirect("/team?error=invalid-seat-count");

  refreshTeamPages();
  redirect("/team?notice=seats-added");
}
