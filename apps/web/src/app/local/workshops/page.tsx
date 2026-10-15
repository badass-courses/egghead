import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { Container } from "@egghead/ui/container";
import { SectionHeader } from "@egghead/ui/structure";

import { listLocalWorkshops, localWorkshopConnection } from "../../../workshops/local-preview";

export const metadata: Metadata = {
  title: "Workshop drafts | egghead",
  robots: { index: false, follow: false },
};

async function WorkshopDrafts({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  await connection();
  if (!localWorkshopConnection()) notFound();
  const { cursor } = await searchParams;
  const page = await listLocalWorkshops(cursor);
  return (
    <Container as="main" size="wide">
      <SectionHeader
        description="Create a workshop in chat, then refresh here to see your draft."
        eyebrow="Local preview"
        title="Workshop drafts"
      />
      {page.workshops.length ? (
        <ol className="egghead-search-results">
          {page.workshops.map((workshop) => (
            <li key={workshop.id}>
              <Link href={`/local/workshops/${encodeURIComponent(workshop.id)}`}>
                <span className="egghead-search-type">
                  {workshop.fields.state === "draft" ? "Draft · Unlisted" : "Published · Public"}
                </span>
                <span className="egghead-search-title">{workshop.fields.title}</span>
                <span className="egghead-search-description">{workshop.fields.description}</span>
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <p className="egghead-empty-state">
          Your first workshop will appear here after you create it in chat.
        </p>
      )}
      {page.nextCursor ? (
        <Link href={`/local/workshops?cursor=${encodeURIComponent(page.nextCursor)}`}>
          More drafts →
        </Link>
      ) : null}
    </Container>
  );
}

export default function WorkshopDraftsPage(props: { searchParams: Promise<{ cursor?: string }> }) {
  return (
    <Suspense fallback={<output>Loading workshop drafts…</output>}>
      <WorkshopDrafts {...props} />
    </Suspense>
  );
}
