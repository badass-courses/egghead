import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache, Suspense } from "react";
import { Container } from "@egghead/ui/container";

import { getPublicLearnerProfile } from "../../../profile/data";
import { ShareProfileButton } from "../share-profile-button";

const loadPublicProfile = cache(getPublicLearnerProfile);

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
  const description = `${profile.learning.completedCount} published Egghead completions.`;
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
      <Container as="div" className="gap-y-10" size="wide">
        <output
          aria-label="Loading learner profile"
          className="breakout border-b border-border-strong pb-8 sm:pb-10"
        >
          <div className="flex items-center gap-4 sm:gap-5">
            <div className="size-16 rounded-2xl border border-border-strong bg-well shadow-well sm:size-20" />
            <div className="grid flex-1 gap-3">
              <div className="h-3 w-28 rounded-full bg-border-strong" />
              <div className="h-9 w-full max-w-sm rounded-lg bg-border-soft" />
              <div className="h-3 w-36 rounded-full bg-border" />
            </div>
          </div>
          <span className="sr-only">Loading learner profile</span>
        </output>
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

  const publicPath = `/profile/${encodeURIComponent(profile.publicId)}`;

  return (
    <main>
      <Container as="div" className="gap-y-10" size="wide">
        <header className="breakout border-b border-border-strong pb-8 sm:pb-10">
          <div className="flex flex-col gap-7 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex min-w-0 items-center gap-4 sm:gap-5">
              <div className="grid size-16 shrink-0 place-items-center rounded-2xl border border-border-strong bg-navy-grad text-2xl font-black text-cream shadow-btn-navy sm:size-20 sm:text-3xl">
                {initialFor(profile.displayName)}
              </div>
              <div className="min-w-0">
                <p className="eyebrow mb-2">Egghead learner</p>
                <h1 className="text-balance text-4xl font-black tracking-tight">
                  {profile.displayName}
                </h1>
                <p className="mt-2 text-sm font-bold text-muted-foreground">
                  {profile.memberSince ? `Member since ${profile.memberSince}` : "Egghead member"}
                </p>
              </div>
            </div>

            <div className="max-w-sm sm:text-right">
              <p className="text-sm text-muted-foreground">
                This public page shows a name, membership date, and published learning activity.
              </p>
              <div className="mt-3 sm:flex sm:justify-end">
                <ShareProfileButton path={publicPath} />
              </div>
            </div>
          </div>

          <dl className="mt-8 flex flex-wrap gap-x-8 gap-y-3 border-t border-border-soft pt-5 text-sm">
            <div className="flex items-baseline gap-2">
              <dd className="text-xl font-black tabular-nums">{profile.learning.completedCount}</dd>
              <dt className="font-bold text-muted-foreground">
                published {profile.learning.completedCount === 1 ? "completion" : "completions"}
              </dt>
            </div>
            <div className="flex items-baseline gap-2">
              <dd className="text-xl font-black tabular-nums">
                {profile.learning.activeMonthCount}
              </dd>
              <dt className="font-bold text-muted-foreground">
                active {profile.learning.activeMonthCount === 1 ? "month" : "months"}
              </dt>
            </div>
          </dl>
        </header>

        <section className="breakout" aria-labelledby="completed-learning-heading">
          <div className="flex flex-col gap-2 border-b border-border-strong pb-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="eyebrow mb-2">Learning record</p>
              <h2 className="text-2xl font-black tracking-tight" id="completed-learning-heading">
                Completed learning
              </h2>
            </div>
            {profile.learning.history.length > 0 ? (
              <p className="max-w-md text-sm text-muted-foreground sm:text-right">
                Published Egghead resources, newest first.
              </p>
            ) : null}
          </div>

          {profile.learning.history.length > 0 ? (
            <div>
              {profile.learning.history.map((month) => (
                <section
                  className="grid gap-3 border-b border-border-soft py-6 sm:grid-cols-[10rem_1fr] sm:gap-8"
                  key={month.key}
                >
                  <h3 className="text-sm font-extrabold uppercase tracking-[0.08em] text-muted-foreground">
                    {month.label}
                  </h3>
                  <ol className="divide-y divide-border-soft">
                    {month.completions.map((completion) => (
                      <li
                        className="grid gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline sm:gap-6"
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
            <div className="border-b border-border-soft py-10 sm:py-14">
              <p className="text-lg font-black">No published completions yet</p>
              <p className="mt-1 max-w-lg text-sm text-muted-foreground">
                Completed Egghead lessons and courses will appear here in chronological order.
              </p>
              <Link
                className="mt-5 inline-flex text-sm font-extrabold underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
                href="/courses"
              >
                Browse courses
              </Link>
            </div>
          )}
        </section>
      </Container>
    </main>
  );
}
