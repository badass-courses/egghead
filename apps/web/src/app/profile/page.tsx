import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { Button } from "@egghead/ui/button";
import { Container } from "@egghead/ui/container";

import { normalizeRequestCountry } from "../../access/evaluate";
import { getCurrentUser } from "../../coursebuilder/current-user";
import { getPrivateAccountProfile } from "../../profile/data";
import { updateProfileName } from "./actions";
import { GithubAccountControl } from "./github-account-control";
import { ShareProfileButton } from "./share-profile-button";

export const metadata: Metadata = {
  title: "Your profile | egghead",
  description: "Manage your Egghead account and learning profile.",
};

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

function initialFor(name: string | null) {
  return name?.trim().charAt(0).toUpperCase() || "E";
}

function ProfileFallback() {
  return (
    <main>
      <Container as="div" className="gap-y-10" size="wide">
        <output
          aria-label="Loading your profile"
          className="breakout border-b border-border-strong pb-8 sm:pb-10"
        >
          <div className="flex items-center gap-4 sm:gap-5">
            <div className="size-16 rounded-2xl border border-border-strong bg-well shadow-well sm:size-20" />
            <div className="grid flex-1 gap-3">
              <div className="h-3 w-20 rounded-full bg-border-strong" />
              <div className="h-9 w-full max-w-sm rounded-lg bg-border-soft" />
              <div className="h-3 w-36 rounded-full bg-border" />
            </div>
          </div>
          <span className="sr-only">Loading your profile</span>
        </output>
      </Container>
    </main>
  );
}

export default function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; updated?: string }>;
}) {
  return (
    <Suspense fallback={<ProfileFallback />}>
      <ProfileContent searchParams={searchParams} />
    </Suspense>
  );
}

async function ProfileContent({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; updated?: string }>;
}) {
  const currentUser = await getCurrentUser();
  if (!currentUser?.id) redirect("/login?callbackUrl=%2Fprofile");

  const requestHeaders = await headers();
  const requestCountry = normalizeRequestCountry(
    requestHeaders.get("x-vercel-ip-country") ??
      requestHeaders.get("cf-ipcountry") ??
      requestHeaders.get("x-country"),
  );
  const [profile, notice] = await Promise.all([
    getPrivateAccountProfile({
      actorUserId: currentUser.id,
      profileUserId: currentUser.id,
      requestCountry,
    }),
    searchParams,
  ]);

  if (!profile) notFound();

  const name = profile.name?.trim() || "Egghead learner";
  const accessTitle = profile.learningAccess.libraryWide
    ? "Full library access"
    : profile.learningAccess.courseSpecific.length > 0
      ? `${profile.learningAccess.courseSpecific.length} included course${profile.learningAccess.courseSpecific.length === 1 ? "" : "s"}`
      : "Individual lesson access";
  const accessDescription = profile.learningAccess.libraryWide
    ? "Your membership includes the Egghead library."
    : "Free resources remain available. Paid access is shown only when it is attached to this account.";

  return (
    <main>
      <Container as="div" className="gap-y-10" size="wide">
        <header className="breakout border-b border-border-strong pb-8 sm:pb-10">
          <div className="flex flex-col gap-7 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex min-w-0 items-center gap-4 sm:gap-5">
              <div className="grid size-16 shrink-0 place-items-center rounded-2xl border border-border-strong bg-navy-grad text-2xl font-black text-cream shadow-btn-navy sm:size-20 sm:text-3xl">
                {initialFor(profile.name)}
              </div>
              <div className="min-w-0">
                <p className="eyebrow mb-2">Account</p>
                <h1 className="truncate text-4xl font-black tracking-tight">{name}</h1>
                <p className="mt-2 text-sm font-bold text-muted-foreground">
                  {formatMemberSince(profile.memberSince)}
                </p>
              </div>
            </div>

            <div className="max-w-sm">
              <p className="text-sm font-extrabold">Public learning profile</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Preview the name and published learning activity other people can see.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link
                  className="press inline-flex items-center justify-center rounded-lg border border-yolk-shadow/40 bg-yolk-grad px-4 py-2 text-sm font-extrabold text-yolk-foreground shadow-btn"
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
          <output className="breakout border-y border-sage-line bg-sage-wash px-4 py-3 text-sm font-extrabold text-sage-foreground">
            Display name updated.
          </output>
        ) : null}

        {notice.error ? (
          <div
            className="breakout border-y border-rust bg-rust/10 px-4 py-3 text-sm font-extrabold text-rust"
            role="alert"
          >
            {notice.error === "invalid-name"
              ? "Enter a display name between 1 and 80 characters."
              : "We could not update your display name. Try again."}
          </div>
        ) : null}

        <div className="breakout grid gap-12 lg:grid-cols-[minmax(0,1.25fr)_minmax(19rem,0.75fr)] lg:gap-16">
          <section aria-labelledby="learning-heading">
            <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border-strong pb-5">
              <div>
                <p className="eyebrow mb-2">Learning</p>
                <h2 className="text-2xl font-black tracking-tight" id="learning-heading">
                  Library and progress
                </h2>
              </div>
              <p className="text-sm font-extrabold text-muted-foreground">
                {profile.learning.completedCount} published{" "}
                {profile.learning.completedCount === 1 ? "completion" : "completions"}
              </p>
            </div>

            <div className="border-b border-border-soft py-6">
              <h3 className="text-lg font-black">{accessTitle}</h3>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{accessDescription}</p>
            </div>

            {profile.learningAccess.courseSpecific.length > 0 ? (
              <div className="border-b border-border-soft py-6">
                <h3 className="text-sm font-extrabold uppercase tracking-[0.08em] text-muted-foreground">
                  Included courses
                </h3>
                <ul className="mt-3 divide-y divide-border-soft border-y border-border-soft">
                  {profile.learningAccess.courseSpecific.map((course) => (
                    <li key={course.id}>
                      <Link
                        className="group flex items-center justify-between gap-4 py-3 font-extrabold"
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

            <div className="pt-6">
              <div className="flex items-baseline justify-between gap-4">
                <h3 className="text-lg font-black">Recent completions</h3>
                <Link
                  className="text-sm font-extrabold underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
                  href="/courses"
                >
                  Browse courses
                </Link>
              </div>
              {profile.learning.recentlyCompleted.length > 0 ? (
                <ol className="mt-3 divide-y divide-border-soft border-y border-border-soft">
                  {profile.learning.recentlyCompleted.map((completion) => (
                    <li
                      className="grid gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline sm:gap-6"
                      key={`${completion.resourceId}:${completion.completedAt.toISOString()}`}
                    >
                      <Link
                        className="font-extrabold underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
                        href={completion.href}
                      >
                        {completion.title}
                      </Link>
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
                <div className="mt-4 border-y border-dashed border-border-strong py-7">
                  <p className="font-extrabold">No published completions yet</p>
                  <p className="mt-1 max-w-lg text-sm text-muted-foreground">
                    Finish a published resource and it will appear here and on your public profile.
                  </p>
                </div>
              )}
            </div>
          </section>

          <aside className="grid content-start gap-10">
            <section aria-labelledby="profile-details-heading">
              <p className="eyebrow mb-2">Identity</p>
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
                    className="h-12 rounded-xl border border-border-strong bg-well px-4 font-bold text-foreground shadow-well outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
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
                    className="h-12 cursor-not-allowed rounded-xl border border-border bg-well/60 px-4 font-bold text-muted-foreground shadow-well"
                    id="profile-email"
                    readOnly
                    type="email"
                    value={profile.email}
                  />
                </label>
                <p className="-mt-3 text-xs text-muted-foreground" id="profile-email-note">
                  Email changes are not available yet.
                </p>

                <Button className="justify-self-start" type="submit">
                  Save changes
                </Button>
              </form>
            </section>

            <section
              className="border-t border-border-strong pt-8"
              aria-labelledby="accounts-heading"
            >
              <p className="eyebrow mb-2">Sign-in</p>
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
            </section>
          </aside>
        </div>
      </Container>
    </main>
  );
}
