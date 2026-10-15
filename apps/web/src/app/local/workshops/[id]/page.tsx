import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { Container } from "@egghead/ui/container";
import { SectionHeader } from "@egghead/ui/structure";

import { getLocalWorkshop, localWorkshopConnection } from "../../../../workshops/local-preview";

export const metadata: Metadata = {
  title: "Workshop draft | egghead",
  robots: { index: false, follow: false },
};

async function WorkshopDraft({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  if (!localWorkshopConnection()) notFound();
  const { id } = await params;
  const workshop = await getLocalWorkshop(id);
  if (!workshop) notFound();
  const { fields } = workshop;
  const date = new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: fields.timezone,
  });
  return (
    <Container as="main" size="wide">
      <Link href="/local/workshops">← Workshop drafts</Link>
      <SectionHeader
        description={fields.description}
        eyebrow="Workshop · Draft · Unlisted"
        title={fields.title}
      />
      <dl className="grid gap-6 border-y border-border py-8 sm:grid-cols-3">
        <div>
          <dt className="text-sm text-muted-foreground">Starts</dt>
          <dd className="mt-2 text-lg">
            <time dateTime={fields.startsAt}>{date.format(new Date(fields.startsAt))}</time>
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">Ends</dt>
          <dd className="mt-2 text-lg">
            <time dateTime={fields.endsAt}>{date.format(new Date(fields.endsAt))}</time>
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">Timezone</dt>
          <dd className="mt-2 text-lg">{fields.timezone}</dd>
        </div>
      </dl>
      {fields.attendeeInstructions ? (
        <section className="py-8">
          <h2 className="text-2xl font-bold">Before we meet</h2>
          <p className="mt-4 max-w-prose whitespace-pre-wrap">{fields.attendeeInstructions}</p>
        </section>
      ) : null}
      <p className="py-8 text-sm text-muted-foreground">
        Local draft preview · Revision {fields.workshopRevision}. Ask in chat to make changes, then
        refresh this page.
      </p>
    </Container>
  );
}

export default function WorkshopDraftPage(props: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<output>Loading workshop…</output>}>
      <WorkshopDraft {...props} />
    </Suspense>
  );
}
