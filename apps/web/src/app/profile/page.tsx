import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { Button } from "@egghead/ui/button";
import { Container } from "@egghead/ui/container";

import { normalizeRequestCountry } from "../../access/evaluate";
import { isEmailAuthConfigured } from "../../coursebuilder/auth-config";
import { getCurrentUser } from "../../coursebuilder/current-user";
import { getPrivateAccountProfile } from "../../profile/data";
import { gravatarUrlForEmail } from "../../profile/gravatar";
import { getEnv } from "../../env";
import { getMembershipBillingSummary } from "../../subscriptions/billing";
import { getOwnedTeamSubscription } from "../../subscriptions/team";
import { manageMembership, signOutOfEgghead, updateProfileName } from "./actions";
import {
  CompletionFilterControls,
  completionFilterFromSearchParam,
} from "./completion-filter-controls";
import { GithubAccountControl } from "./github-account-control";
import { ManageMembershipButton } from "./manage-membership-button";
import { ProfileAvatar } from "./profile-avatar";
import { ShareProfileButton } from "./share-profile-button";
import { SignOutButton } from "./sign-out-button";

export const metadata: Metadata = {
  title: "Your profile | egghead",
  description: "Manage your egghead account and learning profile.",
};

const profilePanelClassName = "rounded-2xl border border-border-strong bg-surface-grad shadow-card";

function formatMemberSince(date: Date | null) {
  if (!date) return "Member date unavailable";

  return `Member since ${new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
  }).format(date)}`;
}

function formatCompletionDate(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatMembershipDate(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function initialFor(name: string | null) {
  return name?.trim().charAt(0).toUpperCase() || "E";
}

function getSubscribeHref() {
  const siteUrl = getEnv("NEXT_PUBLIC_APP_URL");
  if (!siteUrl) throw new Error("NEXT_PUBLIC_APP_URL is required for the profile subscribe link.");

  const pathname = process.env.NODE_ENV === "development" ? "/subscribe" : "/pricing";
  return new URL(pathname, siteUrl).toString();
}

function ProfileFallback() {
  return (
    <main>
      <Container as="div" className="gap-y-6" size="wide">
        <output
          aria-label="Loading your profile"
          className={`${profilePanelClassName} animate-pulse p-5 motion-reduce:animate-none sm:p-8`}
        >
          <div className="flex items-center gap-4 sm:gap-5">
            <div className="size-16 rounded-2xl bg-well shadow-well sm:size-20" />
            <div className="grid flex-1 gap-3">
              <div className="h-9 w-full max-w-sm rounded-lg bg-well" />
              <div className="h-3 w-36 rounded-full bg-border-strong" />
            </div>
          </div>
          <span className="sr-only">Loading your profile</span>
        </output>
        <div
          aria-hidden
          className="h-44 animate-pulse rounded-2xl bg-well shadow-well motion-reduce:animate-none"
        />
      </Container>
    </main>
  );
}

type ProfileSearchParams = {
  billing?: string;
  completion?: string;
  error?: string;
  updated?: string;
};

export default function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<ProfileSearchParams>;
}) {
  return (
    <Suspense fallback={<ProfileFallback />}>
      <ProfileContent searchParams={searchParams} />
    </Suspense>
  );
}

async function ProfileContent({ searchParams }: { searchParams: Promise<ProfileSearchParams> }) {
  const currentUser = await getCurrentUser();
  if (!currentUser?.id) redirect("/login?callbackUrl=%2Fprofile");

  const [requestHeaders, notice] = await Promise.all([headers(), searchParams]);
  const completionFilter = completionFilterFromSearchParam(notice.completion);
  const requestCountry = normalizeRequestCountry(
    requestHeaders.get("x-vercel-ip-country") ??
      requestHeaders.get("cf-ipcountry") ??
      requestHeaders.get("x-country"),
  );
  const [profile, membershipBilling, teamSubscription] = await Promise.all([
    getPrivateAccountProfile({
      actorUserId: currentUser.id,
      profileUserId: currentUser.id,
      requestCountry,
      emailAuthConfigured: isEmailAuthConfigured(),
      ...(completionFilter === "all" ? {} : { recentCompletionFamily: completionFilter }),
    }),
    getMembershipBillingSummary(currentUser.id),
    getOwnedTeamSubscription(currentUser.id),
  ]);

  if (!profile) notFound();

  const name = profile.name?.trim() || "egghead learner";
  const hasLibraryMembership = profile.learningAccess.libraryWide;
  const hasIncludedCourses = profile.learningAccess.courseSpecific.length > 0;
  const membershipDescription = hasLibraryMembership
    ? "Your membership includes the full egghead library."
    : hasIncludedCourses
      ? "Your included courses and free resources remain available. Subscribe for full library access."
      : "Free resources remain available. Subscribe for full library access.";

  return (
    <main>
      <Container as="div" className="gap-y-6 sm:gap-y-8" size="wide">
        <header className={`${profilePanelClassName} overflow-hidden`}>
          <div className="grid gap-7 p-5 sm:p-8 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.55fr)] lg:items-center">
            <div className="flex min-w-0 items-center gap-4 sm:gap-5">
              <ProfileAvatar
                alt={`${name}'s profile picture`}
                fallback={initialFor(profile.name)}
                src={gravatarUrlForEmail(profile.email, 160)}
              />
              <div className="min-w-0">
                <h1 className="truncate text-4xl font-black tracking-tight">{name}</h1>
                <p className="mt-2 text-sm font-bold text-muted-foreground">
                  {formatMemberSince(profile.memberSince)}
                </p>
              </div>
            </div>

            <div className="grid gap-3 lg:justify-items-start">
              <div>
                <h2 className="text-lg font-black">Public learning profile</h2>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  Preview and share the learning activity other people can see.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link
                  className="press inline-flex items-center justify-center rounded-lg border border-border-strong bg-surface-grad px-4 py-2 text-sm font-extrabold text-foreground shadow-btn-ghost"
                  href={profile.publicProfilePath}
                >
                  View public profile
                </Link>
                <ShareProfileButton path={profile.publicProfilePath} />
              </div>
            </div>
          </div>
        </header>

        {notice.updated === "name" ? (
          <output className="rounded-xl border border-sage-line bg-sage-wash px-4 py-3 text-sm font-extrabold text-sage-foreground">
            Display name updated.
          </output>
        ) : null}

        {notice.error ? (
          <div
            className="rounded-xl border border-rust bg-rust/10 px-4 py-3 text-sm font-extrabold text-rust"
            role="alert"
          >
            {notice.error === "invalid-name"
              ? "Enter a display name between 1 and 80 characters."
              : "We could not update your display name. Try again."}
          </div>
        ) : null}

        {notice.billing === "unavailable" ? (
          <div
            className="rounded-xl border border-rust bg-rust/10 px-4 py-3 text-sm font-extrabold text-rust"
            role="alert"
          >
            We could not open Stripe’s membership portal. Try again or contact{" "}
            <a
              className="underline decoration-rust/50 underline-offset-4 hover:decoration-rust"
              href="mailto:support@egghead.io"
            >
              support@egghead.io
            </a>
            .
          </div>
        ) : null}

        <section
          aria-labelledby="membership-heading"
          className={`${profilePanelClassName} overflow-hidden ${hasLibraryMembership ? "" : "shadow-card-deep"}`}
        >
          <div className="grid gap-6 p-5 sm:p-8 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
            <div className="max-w-2xl">
              <p className="flex items-center gap-2 text-sm font-extrabold text-muted-foreground">
                <span
                  aria-hidden
                  className={`size-2.5 shrink-0 rounded-full ${hasLibraryMembership ? "bg-sage" : "bg-rust"}`}
                />
                {hasLibraryMembership ? "Membership active" : "No active membership"}
              </p>
              <h2
                className="mt-3 text-balance text-3xl font-black tracking-tight"
                id="membership-heading"
              >
                {hasLibraryMembership ? "Full library access" : "Unlock the full library"}
              </h2>
              <p className="mt-2 max-w-[62ch] text-pretty text-base text-muted-foreground">
                {membershipDescription}
              </p>
              {hasLibraryMembership ? (
                <dl className="mt-5 grid max-w-2xl gap-x-8 gap-y-3 border-t border-border pt-4 sm:grid-cols-3">
                  <div className="min-w-0">
                    <dt className="text-xs font-extrabold text-muted-foreground">Active plan</dt>
                    <dd className="mt-1 break-words font-extrabold">
                      {membershipBilling?.billingInterval ?? "Billing details unavailable"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-extrabold text-muted-foreground">Cost</dt>
                    <dd className="mt-1 font-extrabold">
                      {membershipBilling?.cost ?? "Not available"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-extrabold text-muted-foreground">
                      {membershipBilling?.cancelAtPeriodEnd ? "Access through" : "Renews"}
                    </dt>
                    <dd className="mt-1 font-extrabold">
                      {membershipBilling
                        ? formatMembershipDate(membershipBilling.renewsAt)
                        : "Billing details unavailable"}
                    </dd>
                  </div>
                </dl>
              ) : null}
              {membershipBilling?.cancelAtPeriodEnd ? (
                <p className="mt-3 text-sm font-bold text-rust">
                  Your membership is set to end on{" "}
                  {formatMembershipDate(membershipBilling.renewsAt)} and will not renew.
                </p>
              ) : null}
            </div>

            {hasLibraryMembership ? (
              <div className="grid w-full justify-items-stretch gap-3 md:w-auto md:min-w-48">
                {teamSubscription ? (
                  <Link
                    className="press inline-flex min-h-11 items-center justify-center rounded-xl border border-yolk-shadow/40 bg-yolk-grad px-5 py-3 text-sm font-extrabold text-yolk-foreground shadow-btn hover:shadow-btn-hover"
                    href="/team"
                  >
                    Manage {teamSubscription.totalSeats} team seats
                  </Link>
                ) : null}
                {membershipBilling ? (
                  <form action={manageMembership}>
                    <ManageMembershipButton />
                  </form>
                ) : (
                  <p className="max-w-56 text-center text-xs text-muted-foreground">
                    Contact support to manage this access.
                  </p>
                )}
              </div>
            ) : (
              <div className="grid justify-items-stretch gap-3 md:justify-items-center">
                <Link
                  className="press inline-flex w-full items-center justify-center rounded-xl border border-yolk-shadow/40 bg-yolk-grad px-7 pt-[15px] pb-[13px] text-base font-extrabold text-yolk-foreground shadow-btn hover:shadow-btn-hover md:min-w-44"
                  href={getSubscribeHref()}
                >
                  Subscribe
                </Link>
                <p className="text-center text-xs text-muted-foreground">
                  Think this is a mistake?{" "}
                  <a
                    className="font-extrabold text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
                    href="mailto:support@egghead.io"
                  >
                    Contact support
                  </a>
                  .
                </p>
              </div>
            )}
          </div>
        </section>

        <div className="grid gap-6 sm:gap-8">
          <section aria-labelledby="learning-heading" className={profilePanelClassName}>
            <div className="grid gap-6 p-5 sm:p-8">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-black tracking-tight" id="learning-heading">
                    Learning progress
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Your completed lessons and courses, plus included courses.
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-3">
                  <Link
                    className="press inline-flex min-h-10 items-center justify-center rounded-lg border border-border-strong bg-surface-grad px-4 py-2 text-sm font-extrabold text-foreground shadow-btn-ghost"
                    href="/profile/progress"
                  >
                    View all progress
                  </Link>
                  <dl className="grid grid-cols-2 gap-2">
                    <div className="min-w-24 rounded-xl bg-well px-4 py-2 text-center shadow-well">
                      <dd className="text-xl font-black tabular-nums">
                        {profile.learning.lessonCount}
                      </dd>
                      <dt className="text-xs font-extrabold text-muted-foreground">
                        {profile.learning.lessonCount === 1 ? "Lesson" : "Lessons"}
                      </dt>
                    </div>
                    <div className="min-w-24 rounded-xl bg-well px-4 py-2 text-center shadow-well">
                      <dd className="text-xl font-black tabular-nums">
                        {profile.learning.courseCount}
                      </dd>
                      <dt className="text-xs font-extrabold text-muted-foreground">
                        {profile.learning.courseCount === 1 ? "Course" : "Courses"}
                      </dt>
                    </div>
                  </dl>
                </div>
              </div>

              {hasIncludedCourses ? (
                <div>
                  <h3 className="text-lg font-black">Included courses</h3>
                  <ul className="mt-3 grid gap-2">
                    {profile.learningAccess.courseSpecific.map((course) => (
                      <li key={course.id}>
                        <Link
                          className="group flex min-h-12 items-center justify-between gap-4 rounded-xl border border-border-strong bg-well px-4 py-3 font-extrabold shadow-well"
                          href={course.href}
                        >
                          <span className="group-hover:underline">{course.title}</span>
                          <span aria-hidden className="text-muted-foreground">
                            →
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div>
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <h3 className="text-lg font-black">Recent completions</h3>
                  <Link
                    className="text-sm font-extrabold underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
                    href="/courses"
                  >
                    Browse courses
                  </Link>
                </div>
                {profile.learning.lessonCount + profile.learning.courseCount > 0 ? (
                  <div className="mt-3">
                    <CompletionFilterControls activeFilter={completionFilter} basePath="/profile" />
                  </div>
                ) : null}
                {profile.learning.recentlyCompleted.length > 0 ? (
                  <ol className="mt-3 grid gap-2">
                    {profile.learning.recentlyCompleted.map((completion) => (
                      <li
                        className="grid gap-1 rounded-xl border border-border-strong bg-well px-4 py-3 shadow-well sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline sm:gap-6"
                        key={`${completion.resourceId}:${completion.completedAt.toISOString()}`}
                      >
                        <div className="min-w-0">
                          <Link
                            className="font-extrabold underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
                            href={completion.href}
                          >
                            {completion.title}
                          </Link>
                          {completion.family === "lesson" ? (
                            <p className="mt-1 text-xs font-bold text-muted-foreground">
                              Lesson
                              {completion.course ? (
                                <>
                                  {" in "}
                                  <Link
                                    className="underline decoration-border-strong underline-offset-4 hover:text-foreground hover:decoration-foreground"
                                    href={completion.course.href}
                                  >
                                    {completion.course.title}
                                  </Link>
                                </>
                              ) : null}
                            </p>
                          ) : completion.family === "course" ? (
                            <p className="mt-1 text-xs font-bold text-muted-foreground">Course</p>
                          ) : null}
                        </div>
                        <time
                          className="text-xs font-bold text-muted-foreground"
                          dateTime={completion.completedAt.toISOString()}
                        >
                          {formatCompletionDate(completion.completedAt)}
                        </time>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="mt-3 rounded-xl border border-dashed border-border-strong bg-well/50 p-5 sm:p-6">
                    <p className="font-extrabold">
                      {completionFilter === "all"
                        ? "No published completions yet"
                        : `No recent ${completionFilter} completions`}
                    </p>
                    <p className="mt-1 max-w-lg text-sm text-muted-foreground">
                      {completionFilter === "all"
                        ? "Finish a published resource and it will appear here and on your public profile."
                        : `Complete a published ${completionFilter} and it will appear here.`}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </section>

          <div className="grid gap-6 md:grid-cols-2">
            <section aria-labelledby="profile-details-heading" className={profilePanelClassName}>
              <div className="p-5 sm:p-6">
                <h2 className="text-2xl font-black tracking-tight" id="profile-details-heading">
                  Profile details
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Your display name is public. Your sign-in email stays private.
                </p>

                <form action={updateProfileName} className="mt-6 grid gap-5">
                  <label className="grid gap-2 text-sm font-extrabold" htmlFor="profile-name">
                    Display name
                    <input
                      aria-label="Display name"
                      autoComplete="name"
                      className="h-12 min-w-0 rounded-xl border border-border-strong bg-well px-4 font-bold text-foreground shadow-well outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                      defaultValue={profile.name ?? ""}
                      id="profile-name"
                      maxLength={80}
                      name="name"
                      required
                    />
                  </label>

                  <label className="grid gap-2 text-sm font-extrabold" htmlFor="profile-email">
                    Sign-in email
                    <input
                      aria-describedby="profile-email-note"
                      aria-label="Sign-in email"
                      className="h-12 min-w-0 cursor-not-allowed rounded-xl border border-border bg-well/60 px-4 font-bold text-muted-foreground shadow-well"
                      id="profile-email"
                      readOnly
                      type="email"
                      value={profile.email}
                    />
                  </label>
                  <p className="-mt-3 text-xs text-muted-foreground" id="profile-email-note">
                    Email changes are not available yet.
                  </p>

                  <Button className="justify-self-start" size="sm" type="submit" variant="ghost">
                    Save display name
                  </Button>
                </form>
              </div>
            </section>

            <section aria-labelledby="accounts-heading" className={profilePanelClassName}>
              <div className="p-5 sm:p-6">
                <h2 className="text-2xl font-black tracking-tight" id="accounts-heading">
                  Connected accounts
                </h2>
                <GithubAccountControl
                  connected={profile.githubConnection.connected}
                  disconnectAllowed={profile.githubConnection.disconnectAllowed}
                />
                <p className="mt-3 text-xs text-muted-foreground">
                  Connection details are private and never appear on your public profile.
                </p>

                <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-5">
                  <div>
                    <h3 className="font-extrabold">Current session</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Sign out of egghead on this device.
                    </p>
                  </div>
                  <form action={signOutOfEgghead}>
                    <SignOutButton />
                  </form>
                </div>
              </div>
            </section>
          </div>
        </div>
      </Container>
    </main>
  );
}
