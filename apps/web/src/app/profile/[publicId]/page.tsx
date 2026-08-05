import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache, Suspense } from "react";
import { Container } from "@egghead/ui/container";

import { getPublicLearnerProfile, getPublicProfileGravatarUrl } from "../../../profile/data";
import { ProfileAvatar } from "../profile-avatar";
import { ShareProfileButton } from "../share-profile-button";

const loadPublicProfile = cache(getPublicLearnerProfile);
const profilePanelClassName = "rounded-2xl border border-border-strong bg-surface-grad shadow-card";

function initialFor(name: string) {
  return name.trim().charAt(0).toUpperCase() || "E";
}

function formatCompletionDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(value));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ publicId: string }>;
}): Promise<Metadata> {
  const { publicId } = await params;
  const profile = await loadPublicProfile(publicId);
  if (!profile) return { title: "Learner not found | egghead" };

  const title = `${profile.displayName}'s learning profile | egghead`;
  const description = `${profile.learning.completedCount} published egghead completions.`;
  const canonicalPath = `/profile/${encodeURIComponent(profile.publicId)}`;

  return {
    title,
    description,
    alternates: {
      canonical: `https://egghead.io${canonicalPath}`,
    },
    openGraph: {
      title,
      description,
      type: "profile",
      url: `https://egghead.io${canonicalPath}`,
    },
  };
}

function PublicProfileFallback() {
  return (
    <main>
      <Container as="div" className="gap-y-6 sm:gap-y-8" size="wide">
        <output
          aria-label="Loading learner profile"
          className={`${profilePanelClassName} animate-pulse p-5 motion-reduce:animate-none sm:p-8`}
        >
          <div className="flex items-center gap-4 sm:gap-5">
            <div className="size-16 rounded-2xl bg-well shadow-well sm:size-20" />
            <div className="grid flex-1 gap-3">
              <div className="h-9 w-full max-w-sm rounded-lg bg-well" />
              <div className="h-3 w-36 rounded-full bg-border-strong" />
            </div>
          </div>
          <span className="sr-only">Loading learner profile</span>
        </output>
        <div
          aria-hidden
          className="h-56 animate-pulse rounded-2xl bg-well shadow-well motion-reduce:animate-none"
        />
      </Container>
    </main>
  );
}

export default function PublicProfilePage({ params }: { params: Promise<{ publicId: string }> }) {
  return (
    <Suspense fallback={<PublicProfileFallback />}>
      <PublicProfileContent params={params} />
    </Suspense>
  );
}

async function PublicProfileContent({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  const profile = await loadPublicProfile(publicId);
  if (!profile) notFound();

  const avatarUrl = profile.avatarUrl ?? (await getPublicProfileGravatarUrl(profile.publicId));
  const publicPath = `/profile/${encodeURIComponent(profile.publicId)}`;

  return (
    <main>
      <Container as="div" className="gap-y-6 sm:gap-y-8" size="wide">
        <header className={`${profilePanelClassName} overflow-hidden`}>
          <div className="grid gap-7 p-5 sm:p-8 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.65fr)] lg:items-center">
            <div className="flex min-w-0 items-center gap-4 sm:gap-5">
              {avatarUrl ? (
                <ProfileAvatar
                  alt={`${profile.displayName}'s profile picture`}
                  fallback={initialFor(profile.displayName)}
                  src={avatarUrl}
                />
              ) : (
                <div className="grid size-16 shrink-0 place-items-center rounded-2xl border border-border-strong bg-navy-grad text-2xl font-black text-cream shadow-btn-navy sm:size-20 sm:text-3xl">
                  {initialFor(profile.displayName)}
                </div>
              )}
              <div className="min-w-0">
                <h1 className="text-balance text-4xl font-black tracking-tight">
                  {profile.displayName}
                </h1>
                <p className="mt-2 text-sm font-bold text-muted-foreground">
                  {profile.memberSince ? `Member since ${profile.memberSince}` : "egghead member"}
                </p>
              </div>
            </div>

            <div className="grid gap-4">
              <p className="max-w-md text-sm text-muted-foreground">
                This public profile shows a name, membership date, and published learning activity.
              </p>
              <dl className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-well px-4 py-3 shadow-well">
                  <dd className="text-xl font-black tabular-nums">
                    {profile.learning.completedCount}
                  </dd>
                  <dt className="mt-0.5 text-xs font-extrabold text-muted-foreground">
                    Published {profile.learning.completedCount === 1 ? "completion" : "completions"}
                  </dt>
                </div>
                <div className="rounded-xl bg-well px-4 py-3 shadow-well">
                  <dd className="text-xl font-black tabular-nums">
                    {profile.learning.activeMonthCount}
                  </dd>
                  <dt className="mt-0.5 text-xs font-extrabold text-muted-foreground">
                    Active {profile.learning.activeMonthCount === 1 ? "month" : "months"}
                  </dt>
                </div>
              </dl>
              <div className="justify-self-start">
                <ShareProfileButton path={publicPath} />
              </div>
            </div>
          </div>
        </header>

        <section aria-labelledby="completed-learning-heading" className={profilePanelClassName}>
          <div className="grid gap-6 p-5 sm:p-8">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-2xl font-black tracking-tight" id="completed-learning-heading">
                  Completed learning
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Published egghead resources, newest first.
                </p>
              </div>
              {profile.learning.history.length > 0 ? (
                <Link
                  className="text-sm font-extrabold underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
                  href="/courses"
                >
                  Browse courses
                </Link>
              ) : null}
            </div>

            {profile.learning.history.length > 0 ? (
              <div className="grid gap-7">
                {profile.learning.history.map((month) => (
                  <section key={month.key}>
                    <h3 className="text-sm font-extrabold uppercase tracking-[0.08em] text-muted-foreground">
                      {month.label}
                    </h3>
                    <ol className="mt-3 grid gap-2">
                      {month.completions.map((completion) => (
                        <li
                          className="grid gap-1 rounded-xl border border-border-strong bg-well px-4 py-3 shadow-well sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline sm:gap-6"
                          key={`${completion.resourceId}:${completion.completedAt}`}
                        >
                          <Link
                            className="font-extrabold underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
                            href={completion.href}
                          >
                            {completion.title}
                          </Link>
                          <time
                            className="text-xs font-bold text-muted-foreground"
                            dateTime={completion.completedAt}
                          >
                            {formatCompletionDate(completion.completedAt)}
                          </time>
                        </li>
                      ))}
                    </ol>
                  </section>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-border-strong bg-well/50 p-5 sm:p-6">
                <p className="text-lg font-black">No published completions yet</p>
                <p className="mt-1 max-w-lg text-sm text-muted-foreground">
                  Completed egghead lessons and courses will appear here in chronological order.
                </p>
                <Link
                  className="mt-5 inline-flex rounded-lg border border-border-strong bg-surface-grad px-4 py-2 text-sm font-extrabold text-foreground shadow-btn-ghost"
                  href="/courses"
                >
                  Browse courses
                </Link>
              </div>
            )}
          </div>
        </section>
      </Container>
    </main>
  );
}
