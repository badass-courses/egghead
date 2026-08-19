import type { Metadata } from "next";
import Link from "next/link";

import { Container } from "@egghead/ui/container";
import { SectionHeader } from "@egghead/ui/structure";

import {
  formatWorkshopDate,
  formatWorkshopPrice,
  getUpcomingWorkshops,
} from "../../content/workshop";

export const metadata: Metadata = {
  description: "Upcoming live, hands-on workshops from egghead instructors.",
  title: "Live workshops | egghead",
};

export default async function WorkshopsPage() {
  const workshops = await getUpcomingWorkshops();

  return (
    <Container as="main" size="wide">
      <SectionHeader
        description="Focused live sessions where you build alongside an expert, ask questions, and leave with something that works."
        eyebrow="Learn together"
        title="Live workshops"
      />

      {workshops.length > 0 ? (
        <ol className="egghead-workshop-list">
          {workshops.map((workshop, index) => (
            <li key={workshop.id}>
              <Link className="egghead-workshop-card" href={`/workshops/${workshop.slug}`}>
                <span className="egghead-workshop-card-number">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="egghead-workshop-card-copy">
                  <span className="egghead-workshop-card-date">
                    {workshop.status === "in-progress"
                      ? "Happening now"
                      : formatWorkshopDate(workshop)}
                  </span>
                  <strong>{workshop.title}</strong>
                  {workshop.description ? <span>{workshop.description}</span> : null}
                </span>
                <span className="egghead-workshop-card-offer">
                  {workshop.offer ? (
                    <>
                      <small>from</small>
                      <strong>{formatWorkshopPrice(workshop.offer.currentPrice)}</strong>
                    </>
                  ) : (
                    <small>Details soon</small>
                  )}
                  <span aria-hidden>→</span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <p className="egghead-empty-state">
          No live workshops are scheduled right now. Check back soon.
        </p>
      )}
    </Container>
  );
}
