import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { Container } from "@egghead/ui/container";
import { SectionHeader } from "@egghead/ui/structure";
import { listUpcomingWorkshops } from "../../workshops/catalog";

export const metadata: Metadata = { title: "Workshops | egghead" };

async function Workshops({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  await connection();
  const { cursor } = await searchParams;
  const page = await listUpcomingWorkshops(cursor);
  return (
    <>
      {page.workshops.length ? (
        <ol className="egghead-search-results">
          {page.workshops.map((workshop) => (
            <li key={workshop.id}>
              <Link href={`/workshops/${encodeURIComponent(workshop.id)}`}>
                <time className="egghead-search-type" dateTime={workshop.startsAt}>
                  {new Intl.DateTimeFormat("en-US", {
                    dateStyle: "long",
                    timeStyle: "short",
                    timeZone: workshop.timezone,
                  }).format(new Date(workshop.startsAt))}{" "}
                  · {workshop.timezone}
                </time>
                <span className="egghead-search-title">{workshop.title}</span>
                <span className="egghead-search-description">{workshop.description}</span>
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <p className="egghead-empty-state">No upcoming workshops. Check back for new workshops.</p>
      )}
      {page.nextCursor ? (
        <Link href={`/workshops?cursor=${encodeURIComponent(page.nextCursor)}`}>
          More workshops
        </Link>
      ) : null}
    </>
  );
}

function WorkshopsSkeleton() {
  return (
    <output className="block" aria-label="Loading workshops">
      <span className="sr-only">Loading workshops…</span>
      <div aria-hidden className="grid gap-3.5 motion-safe:animate-pulse">
        {[0, 1, 2].map((item) => (
          <div
            key={item}
            className="grid gap-3 rounded-2xl border border-border bg-surface-grad px-5 py-5 sm:px-6"
          >
            <div className="h-3 w-40 max-w-full rounded bg-border-strong" />
            <div className="h-6 w-3/4 max-w-lg rounded bg-border-strong" />
            <div className="h-4 w-full max-w-2xl rounded bg-well" />
            <div className="h-4 w-2/3 max-w-xl rounded bg-well" />
          </div>
        ))}
      </div>
    </output>
  );
}

export default function WorkshopsPage(props: { searchParams: Promise<{ cursor?: string }> }) {
  return (
    <Container as="main" size="wide">
      <SectionHeader
        title="Workshops"
        description="Upcoming workshops with the people building the tools you use."
      />
      <Suspense fallback={<WorkshopsSkeleton />}>
        <Workshops {...props} />
      </Suspense>
    </Container>
  );
}
