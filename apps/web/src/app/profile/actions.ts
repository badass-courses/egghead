"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isEmailAuthConfigured, isGithubAuthConfigured } from "../../coursebuilder/auth-config";
import { getCurrentUser } from "../../coursebuilder/current-user";
import { profileNameSchema } from "../../profile/contracts";
import { updatePrivateProfileName } from "../../profile/data";
import { disconnectPrivateGithubAccount } from "../../profile/github-disconnect";
import { signIn, signOut } from "../../server/auth";
import { getMembershipBillingPortalUrl } from "../../subscriptions/billing";

export type GithubDisconnectActionResult =
  | { status: "disconnected" }
  | { status: "last-sign-in-method" }
  | { status: "missing" }
  | { status: "unauthorized" }
  | { status: "error" };

export async function signOutOfEgghead() {
  await signOut({ redirectTo: "/" });
}

export async function connectGithubAccount() {
  const currentUser = await getCurrentUser();
  if (!currentUser?.id) redirect("/login?callbackUrl=%2Fprofile");
  if (!isGithubAuthConfigured()) redirect("/profile");

  await signIn("github", { redirectTo: "/profile" });
}

export async function manageMembership() {
  const currentUser = await getCurrentUser();
  if (!currentUser?.id) redirect("/login?callbackUrl=%2Fprofile");

  const billingPortalUrl = await getMembershipBillingPortalUrl(currentUser.id);
  if (!billingPortalUrl) redirect("/profile?billing=unavailable");

  redirect(billingPortalUrl);
}

export async function updateProfileName(formData: FormData) {
  const currentUser = await getCurrentUser();
  if (!currentUser?.id) redirect("/login?callbackUrl=%2Fprofile");

  const parsedName = profileNameSchema.safeParse(formData.get("name"));
  if (!parsedName.success) redirect("/profile?error=invalid-name");

  const result = await updatePrivateProfileName({
    actorUserId: currentUser.id,
    profileUserId: currentUser.id,
    name: parsedName.data,
  });

  if (!result.updated) redirect("/profile?error=account-not-found");

  revalidatePath("/profile");
  revalidatePath(`/profile/${encodeURIComponent(currentUser.id)}`);
  redirect("/profile?updated=name");
}

export async function disconnectGithubAccount(): Promise<GithubDisconnectActionResult> {
  const currentUser = await getCurrentUser();
  if (!currentUser?.id) return { status: "unauthorized" };

  try {
    const result = await disconnectPrivateGithubAccount({
      actorUserId: currentUser.id,
      profileUserId: currentUser.id,
      emailSignInAvailable: isEmailAuthConfigured() && Boolean(currentUser.email?.trim()),
    });

    if (result.status === "disconnected") {
      revalidatePath("/profile");
      return result;
    }

    if (result.status === "conflict") return { status: "error" };

    return result;
  } catch {
    return { status: "error" };
  }
}
