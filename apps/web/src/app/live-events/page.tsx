import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { Container } from "@egghead/ui/container";
import { SectionHeader } from "@egghead/ui/structure";
import { listUpcomingWorkshops } from "../../workshops/catalog";

export const metadata: Metadata = { title: "Live events | egghead" };

async function LiveEvents({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  await connection();
  const { cursor } = await searchParams;
  const page = await listUpcomingWorkshops(cursor);
  return (
    <Container as="main" size="wide">
      <SectionHeader
        title="Live events"
        description="Upcoming workshops with the people building the tools you use."
      />
      {page.workshops.length ? (
        <ol className="egghead-search-results">
          {page.workshops.map((workshop) => (
            <li key={workshop.id}>
              <Link href={`/workshop/${encodeURIComponent(workshop.id)}`}>
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
        <p className="egghead-empty-state">
          No upcoming live events. Check back for new workshops.
        </p>
      )}
      {page.nextCursor ? (
        <Link href={`/live-events?cursor=${encodeURIComponent(page.nextCursor)}`}>
          More live events
        </Link>
      ) : null}
    </Container>
  );
}

export default function LiveEventsPage(props: { searchParams: Promise<{ cursor?: string }> }) {
  return (
    <Suspense fallback={<output>Loading live events…</output>}>
      <LiveEvents {...props} />
    </Suspense>
  );
}
