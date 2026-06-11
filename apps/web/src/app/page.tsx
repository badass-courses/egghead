import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { Container } from "@egghead/ui/container";
import { cn } from "@egghead/ui/utils";

import { getHomeContent, type HomeContentItem, type HomeStats } from "../content/home";

/* List card language from egghead-brand/components.html ("Latest lessons"
   card): one surface card, header row with a View-all chip, divided rows
   with a framed thumb (or monogram square), tag, title, description. */

const MONOGRAM: Record<string, string> = {
  course: "bg-yolk-grad border-yolk-shadow/40 text-yolk-foreground shadow-btn",
  article: "bg-rust-grad border-rust-deep text-cream",
  guide: "bg-sky-grad border-[#86b8c9] text-yolk-foreground",
  podcast: "bg-navy-grad border-black/40 text-cream",
  talk: "bg-navy-grad border-black/40 text-cream",
  tip: "bg-sage border-[#85a674] text-yolk-foreground",
};

const DEFAULT_MONOGRAM = "bg-well border-border-strong text-muted-foreground shadow-well";

function monogram(title: string) {
  return title
    .split(/\s+/)
    .filter((word) => /^[a-z0-9]/i.test(word))
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

function familyLabel(family: string) {
  return family.replace(/-/g, " ");
}

function ListCard({
  children,
  title,
  viewAllHref,
}: {
  children: ReactNode;
  title: string;
  viewAllHref: string;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border bg-surface-grad shadow-card">
      <div className="flex items-center justify-between gap-4 border-b border-border-soft px-6 py-4">
        <h2 className="text-lg font-black">{title}</h2>
        <Link
          className="press rounded-lg border border-border-strong bg-surface-grad px-3.5 py-1.5 text-sm font-extrabold text-muted-foreground shadow-btn-ghost"
          href={viewAllHref}
        >
          View all →
        </Link>
      </div>
      <ol className="divide-y divide-border-soft">{children}</ol>
    </section>
  );
}

function ContentRow({ item }: { item: HomeContentItem }) {
  return (
    <li>
      <Link
        className="group flex items-center gap-4 px-6 py-4 transition-colors hover:bg-well/60"
        href={item.href}
      >
        {item.imageUrl ? (
          <span className="relative h-[4.2rem] w-28 shrink-0 overflow-hidden rounded-lg border border-black/40 bg-navy-grad shadow-btn-navy">
            <Image
              alt=""
              className="absolute inset-0 size-full object-cover"
              height={120}
              src={item.imageUrl}
              unoptimized
              width={180}
            />
            {item.lessonCount ? (
              <span className="absolute right-1.5 bottom-1 rounded bg-black/60 px-1 text-[10px] font-bold text-cream">
                {item.lessonCount} lessons
              </span>
            ) : null}
          </span>
        ) : (
          <span
            className={cn(
              "grid size-11 shrink-0 place-items-center rounded-xl border text-sm font-black",
              MONOGRAM[item.family] ?? DEFAULT_MONOGRAM,
            )}
          >
            {monogram(item.title)}
          </span>
        )}

        <span className="min-w-0 flex-1">
          <span className="block text-[10px] font-black uppercase tracking-wider text-rust">
            {item.tagLabel ?? familyLabel(item.family)}
          </span>
          <span className="block truncate font-extrabold leading-snug">{item.title}</span>
          {item.description ? (
            <span className="block truncate text-sm font-semibold text-muted-foreground">
              {item.description}
            </span>
          ) : null}
        </span>

        {!item.imageUrl && item.lessonCount ? (
          <span className="shrink-0 text-sm font-bold text-muted-foreground">
            {item.lessonCount} {item.lessonCount === 1 ? "lesson" : "lessons"}
          </span>
        ) : null}

        <span
          aria-hidden
          className="grid size-10 shrink-0 place-items-center rounded-lg border border-border-strong bg-surface-grad text-sm font-black text-muted-foreground shadow-btn-ghost transition-[filter] duration-150 group-hover:brightness-[var(--press-brightness)]"
        >
          →
        </span>
      </Link>
    </li>
  );
}

function statLabel(value: number) {
  if (value >= 1000) return `${Math.floor(value / 100) * 100}`.replace(/(\d)(?=(\d{3})$)/, "$1,");
  if (value >= 100) return `${Math.floor(value / 10) * 10}`;
  return `${value}`;
}

function StatChip({ label, value }: { label: string; value: number }) {
  if (value <= 0) return null;

  return (
    <div className="rounded-xl border border-border-strong bg-well px-4 py-2.5 text-center shadow-well">
      <p className="font-black">{statLabel(value)}+</p>
      <p className="text-[10px] font-extrabold tracking-wider text-muted-foreground uppercase">
        {label}
      </p>
    </div>
  );
}

/* Hero from egghead-brand/layout.html: badge, yolk-highlighted headline,
   two CTAs, hand note — eggo with a sticky note and stat chips beside.
   The sticky note stays paper-yellow in dark mode on purpose. */
function Hero({
  latestCourse,
  stats,
}: {
  latestCourse: HomeContentItem | undefined;
  stats: HomeStats;
}) {
  return (
    <section className="grid items-center gap-10 md:grid-cols-[1.5fr_1fr]">
      <div className="space-y-6">
        {latestCourse ? (
          <Link
            className="press inline-flex max-w-full items-center gap-1.5 rounded-full border border-border-strong bg-surface-grad px-3.5 py-1.5 text-xs font-extrabold shadow-btn-ghost"
            href={latestCourse.href}
          >
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full bg-sage shadow-[0_0_4px_var(--color-sage)]"
            />
            <span className="truncate">new course: {latestCourse.title}</span>
          </Link>
        ) : null}

        <h1 className="text-5xl font-black tracking-tight" style={{ lineHeight: 1.04 }}>
          Learn the tools
          <br />
          that{" "}
          <span className="relative inline-block">
            compound
            <span
              aria-hidden
              className="absolute inset-x-[-2px] bottom-1.5 -z-10 h-4 rotate-[-1deg] rounded-sm bg-yolk/50"
            />
          </span>
          .
        </h1>

        <p className="max-w-md text-lg font-semibold text-muted-foreground">
          Concise video lessons on AI dev tools and modern web craft. Made by working engineers who
          respect your time.
        </p>

        <div className="flex flex-wrap items-center gap-4 pt-1">
          <Link
            className="press inline-flex items-center gap-2.5 rounded-xl border border-yolk-shadow/40 bg-yolk-grad px-7 pt-[15px] pb-[13px] text-base font-extrabold text-yolk-foreground shadow-btn hover:shadow-btn-hover"
            href="/courses"
          >
            <svg fill="currentColor" height="14" viewBox="0 0 13 14" width="13">
              <path d="M1 1.8c0-.8.9-1.3 1.6-.9l9 5.2c.7.4.7 1.4 0 1.8l-9 5.2c-.7.4-1.6-.1-1.6-.9V1.8z" />
            </svg>
            Start learning
          </Link>
          <Link
            className="press inline-flex items-center gap-2 rounded-xl border border-black/40 bg-navy-grad px-7 pt-[15px] pb-[13px] font-extrabold text-cream shadow-btn-navy"
            href="/lessons"
          >
            Browse lessons
            <svg
              fill="none"
              height="12"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              viewBox="0 0 15 12"
              width="15"
            >
              <path d="M1 6h12M9 1.5L13.5 6 9 10.5" />
            </svg>
          </Link>
        </div>

        <p className="rotate-[-1deg] font-hand text-2xl text-rust">
          no fluff. all signal. two minutes at a time. ✏️
        </p>
      </div>

      <div className="relative hidden md:block">
        <Image
          alt="Eggo the egghead mascot watering tiny sprouting code saplings"
          className="mx-auto w-72 drop-shadow-[0_10px_14px_rgba(0,0,0,0.3)]"
          height={480}
          priority
          src="/eggo-watering.png"
          width={480}
        />

        <div className="shadow-sticky absolute -top-6 -right-2 w-40 rotate-[3deg] rounded-[2px] bg-gradient-to-b from-[#fbefa9] to-[#f3df7e] p-3.5 pt-5">
          <span className="absolute -top-2.5 left-1/2 h-4 w-12 -translate-x-1/2 rotate-[-2deg] bg-[#e8d9a8]/80 shadow-sm" />
          <p className="font-hand text-xl leading-tight text-yolk-foreground">
            having fun IS the work ★
          </p>
        </div>

        <div className="mt-5 flex justify-center gap-3">
          <StatChip label="Lessons" value={stats.lessons} />
          <StatChip label="Courses" value={stats.courses} />
          <StatChip label="Articles" value={stats.articles} />
        </div>
      </div>
    </section>
  );
}

function SearchForm() {
  return (
    <form action="/q" className="egghead-home-search" method="get">
      <input aria-label="Search egghead" name="q" placeholder="Search courses, lessons, articles" />
      <button type="submit">Search</button>
    </form>
  );
}

function BrowseLinks() {
  return (
    <nav aria-label="Browse egghead" className="egghead-home-nav">
      <Link href="/courses">Courses</Link>
      <Link href="/lessons">Lessons</Link>
      <Link href="/blog">Articles</Link>
      <Link href="/tips">Tips</Link>
      <Link href="/podcasts">Podcasts</Link>
      <Link href="/talks">Talks</Link>
    </nav>
  );
}

export default async function Home() {
  const content = await getHomeContent();

  return (
    <Container as="main" size="wide">
      <Hero latestCourse={content.courses[0]} stats={content.stats} />
      <SearchForm />
      <BrowseLinks />

      <ListCard title="⚡ Latest courses" viewAllHref="/courses">
        {content.courses.length > 0 ? (
          content.courses.map((item) => <ContentRow item={item} key={item.id} />)
        ) : (
          <li className="px-6 py-4">
            <p className="egghead-empty-state">No courses are available yet.</p>
          </li>
        )}
      </ListCard>

      <ListCard title="✏️ Fresh off the press" viewAllHref="/q">
        {content.resources.length > 0 ? (
          content.resources.map((item) => <ContentRow item={item} key={item.id} />)
        ) : (
          <li className="px-6 py-4">
            <p className="egghead-empty-state">No content is available yet.</p>
          </li>
        )}
      </ListCard>
    </Container>
  );
}
