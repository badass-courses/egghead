import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Container } from "@egghead/ui/container";

import { getCurrentUser } from "../../../coursebuilder/current-user";
import type { ProfileCompletion } from "../../../profile/contracts";
import { getPrivateLearningProgress } from "../../../profile/data";
import {
  progressHref,
  progressRouteStateFromSearchParams,
  type ProgressSearchParams,
} from "./progress-query";
import { ProgressViewControls } from "./progress-view-controls";

export const metadata: Metadata = {
  title: "Your learning progress | egghead",
  description: "Review your completed egghead lessons, courses, and learning activity.",
};

type CompletionMonth = {
  key: string;
  label: string;
  completions: ProfileCompletion[];
};

function groupCompletionsByMonth(completions: readonly ProfileCompletion[]) {
  const groups = new Map<string, CompletionMonth>();

  for (const completion of completions) {
    const date = completion.completedAt;
    const key = `${String(date.getUTCFullYear())}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    const existing = groups.get(key);

    if (existing) {
      existing.completions.push(completion);
    } else {
      groups.set(key, {
        key,
        label: new Intl.DateTimeFormat("en-US", {
          month: "long",
          timeZone: "UTC",
          year: "numeric",
        }).format(date),
        completions: [completion],
      });
    }
  }

  return [...groups.values()];
}

function formatCompletionDate(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
}

function completionFamilyLabel(family: ProfileCompletion["family"]) {
  if (family === "case-study") return "Case study";
  if (family === "success-story") return "Success story";
  return `${family.charAt(0).toUpperCase()}${family.slice(1)}`;
}

function ProgressFallback() {
  return (
    <main>
      <Container as="div" className="gap-y-6 sm:gap-y-8" size="wide">
        <div className="h-52 animate-pulse rounded-2xl bg-well shadow-well motion-reduce:animate-none" />
        <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <div className="h-80 animate-pulse rounded-2xl bg-well shadow-well motion-reduce:animate-none" />
          <div className="h-[32rem] animate-pulse rounded-2xl bg-well shadow-well motion-reduce:animate-none" />
        </div>
      </Container>
    </main>
  );
}

export default function ProgressPage({
  searchParams,
}: {
  searchParams: Promise<ProgressSearchParams>;
}) {
  return (
    <Suspense fallback={<ProgressFallback />}>
      <ProgressContent searchParams={searchParams} />
    </Suspense>
  );
}

async function ProgressContent({ searchParams }: { searchParams: Promise<ProgressSearchParams> }) {
  const [currentUser, rawSearchParams] = await Promise.all([getCurrentUser(), searchParams]);
  if (!currentUser?.id) redirect("/login?callbackUrl=%2Fprofile%2Fprogress");

  const routeState = progressRouteStateFromSearchParams(rawSearchParams);
  const progress = await getPrivateLearningProgress({
    actorUserId: currentUser.id,
    profileUserId: currentUser.id,
    query: {
      ...(routeState.completion === "all" ? {} : { completionFamily: routeState.completion }),
      order: routeState.order,
      page: routeState.page,
      ...(routeState.search ? { search: routeState.search } : {}),
    },
  });
  const viewState = { ...routeState, page: progress.page };
  const months = groupCompletionsByMonth(progress.completions);
  const firstResult = progress.totalCount === 0 ? 0 : (progress.page - 1) * progress.pageSize + 1;
  const lastResult = Math.min(progress.page * progress.pageSize, progress.totalCount);
  const hasNarrowedView = viewState.completion !== "all" || viewState.search.length > 0;

  return (
    <main>
      <Container as="div" className="gap-y-6 sm:gap-y-8" size="wide">
        <header className="overflow-hidden rounded-2xl bg-surface-grad shadow-card">
          <div className="p-5 sm:p-8">
            <Link
              className="text-sm font-extrabold underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
              href="/profile"
            >
              Back to profile
            </Link>
            <div className="mt-6 grid gap-7 lg:grid-cols-[minmax(0,1fr)_minmax(28rem,0.72fr)] lg:items-end">
              <div>
                <h1 className="max-w-2xl text-balance text-4xl font-black tracking-tight sm:text-5xl">
                  Your learning progress
                </h1>
                <p className="mt-3 max-w-[62ch] text-pretty text-base text-muted-foreground">
                  A complete record of the published egghead resources you have finished. Find a
                  completion, revisit the material, or take stock of where you have been.
                </p>
              </div>
              <div className="grid gap-3">
                <dl className="grid grid-cols-3 divide-x divide-border-strong rounded-xl bg-well py-4 shadow-well">
                  <div className="min-w-0 px-3 text-center sm:px-5 sm:text-left">
                    <dd className="text-2xl font-black tabular-nums">{progress.lessonCount}</dd>
                    <dt className="mt-0.5 text-xs font-extrabold text-muted-foreground">
                      {progress.lessonCount === 1 ? "Lesson" : "Lessons"}
                    </dt>
                  </div>
                  <div className="min-w-0 px-3 text-center sm:px-5 sm:text-left">
                    <dd className="text-2xl font-black tabular-nums">{progress.courseCount}</dd>
                    <dt className="mt-0.5 text-xs font-extrabold text-muted-foreground">
                      {progress.courseCount === 1 ? "Course" : "Courses"}
                    </dt>
                  </div>
                  <div className="min-w-0 px-3 text-center sm:px-5 sm:text-left">
                    <dd className="text-2xl font-black tabular-nums">
                      {progress.activeMonthCount}
                    </dd>
                    <dt className="mt-0.5 text-xs font-extrabold text-muted-foreground">
                      Active {progress.activeMonthCount === 1 ? "month" : "months"}
                    </dt>
                  </div>
                </dl>
                <p
                  aria-label={`Current learning streak: ${progress.currentStreakDays} ${progress.currentStreakDays === 1 ? "day" : "days"}`}
                  className={`inline-flex min-h-10 items-center justify-self-start rounded-full px-4 py-2 text-sm font-extrabold tabular-nums lg:justify-self-end ${
                    progress.currentStreakDays > 0
                      ? "border border-sage-line bg-sage-wash text-sage-foreground"
                      : "bg-well text-muted-foreground shadow-well"
                  }`}
                  title="Consecutive UTC days with a completed lesson or course"
                >
                  {progress.currentStreakDays}-day learning streak
                </p>
              </div>
            </div>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-start">
          <ProgressViewControls state={viewState} />
          <section
            aria-labelledby="completion-record-heading"
            className="min-w-0 rounded-2xl bg-surface-grad shadow-card"
          >
            <div className="p-5 sm:p-8">
              <div className="flex flex-col gap-3 border-b border-border-strong pb-5 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2 className="text-2xl font-black tracking-tight" id="completion-record-heading">
                    Completion record
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {progress.totalCount > 0
                      ? `Showing ${firstResult}–${lastResult} of ${progress.totalCount}`
                      : "No completions in this view"}
                  </p>
                </div>
                {viewState.search ? (
                  <p className="max-w-full truncate text-sm font-bold text-muted-foreground">
                    Results for{" "}
                    <span className="font-black text-foreground">{viewState.search}</span>
                  </p>
                ) : null}
              </div>

              {months.length > 0 ? (
                <div className="mt-2">
                  {months.map((month) => (
                    <section className="pt-7" key={month.key}>
                      <h3 className="text-sm font-extrabold uppercase tracking-[0.08em] text-muted-foreground">
                        {month.label}
                      </h3>
                      <ol className="mt-2 divide-y divide-border-strong">
                        {month.completions.map((completion) => (
                          <li
                            className="grid gap-2 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline sm:gap-6"
                            key={`${completion.resourceId}:${completion.completedAt.toISOString()}`}
                          >
                            <div className="min-w-0">
                              <Link
                                className="text-base font-extrabold underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
                                href={completion.href}
                              >
                                {completion.title}
                              </Link>
                              <p className="mt-1 text-xs font-bold text-muted-foreground">
                                {completionFamilyLabel(completion.family)}
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
                    </section>
                  ))}
                </div>
              ) : (
                <div className="py-10 sm:py-14">
                  <h3 className="text-xl font-black">
                    {hasNarrowedView ? "Nothing matches this view" : "No published completions yet"}
                  </h3>
                  <p className="mt-2 max-w-lg text-sm text-muted-foreground">
                    {hasNarrowedView
                      ? "Try a broader search or reset the controls to see your full record."
                      : "Finish a published lesson or course and it will appear here."}
                  </p>
                  <Link
                    className="press mt-6 inline-flex items-center justify-center rounded-lg border border-border-strong bg-surface-grad px-4 py-2 text-sm font-extrabold text-foreground shadow-btn-ghost"
                    href={hasNarrowedView ? "/profile/progress" : "/courses"}
                  >
                    {hasNarrowedView ? "Reset view" : "Browse courses"}
                  </Link>
                </div>
              )}

              {progress.totalPages > 1 ? (
                <nav
                  aria-label="Completion record pages"
                  className="mt-7 flex items-center justify-between gap-4 border-t border-border-strong pt-5"
                >
                  {progress.page > 1 ? (
                    <Link
                      className="press inline-flex min-h-10 items-center rounded-lg border border-border-strong bg-surface-grad px-4 py-2 text-sm font-extrabold shadow-btn-ghost"
                      href={progressHref(viewState, { page: progress.page - 1 })}
                      scroll={false}
                    >
                      Previous
                    </Link>
                  ) : (
                    <span className="inline-flex min-h-10 items-center px-4 text-sm font-extrabold text-muted-foreground/70">
                      Previous
                    </span>
                  )}
                  <p className="text-center text-xs font-extrabold text-muted-foreground">
                    Page {progress.page} of {progress.totalPages}
                  </p>
                  {progress.page < progress.totalPages ? (
                    <Link
                      className="press inline-flex min-h-10 items-center rounded-lg border border-border-strong bg-surface-grad px-4 py-2 text-sm font-extrabold shadow-btn-ghost"
                      href={progressHref(viewState, { page: progress.page + 1 })}
                      scroll={false}
                    >
                      Next
                    </Link>
                  ) : (
                    <span className="inline-flex min-h-10 items-center px-4 text-sm font-extrabold text-muted-foreground/70">
                      Next
                    </span>
                  )}
                </nav>
              ) : null}
            </div>
          </section>
        </div>
      </Container>
    </main>
  );
}
