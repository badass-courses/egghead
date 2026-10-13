import Image from "next/image";
import Link from "next/link";

import { Container } from "@egghead/ui/container";

import { MarkdownContent } from "./markdown-content";
import { formatWorkshopDate, formatWorkshopPrice } from "@egghead/workshops/format";
import type { Workshop, WorkshopStatus, RegistrationState } from "@egghead/workshops/contracts";

const STATUS_LABEL: Record<WorkshopStatus, string> = {
  "in-progress": "Happening now",
  past: "Workshop complete",
  "schedule-pending": "Schedule coming soon",
  upcoming: "Upcoming live workshop",
};

function WorkshopOfferCard({ workshop }: { workshop: Workshop }) {
  const offer = workshop.offer;
  const registration = workshop.registration;

  return (
    <aside aria-label="Workshop registration" className="egghead-workshop-offer">
      <p className="egghead-workshop-offer-kicker">Your live workshop seat</p>
      {offer ? (
        <div className="egghead-workshop-price-row">
          <strong>{formatWorkshopPrice(offer.currentPrice)}</strong>
          {offer.currentPrice < offer.fullPrice ? (
            <span>{formatWorkshopPrice(offer.fullPrice)}</span>
          ) : null}
        </div>
      ) : (
        <p className="egghead-workshop-price-pending">Pricing coming soon</p>
      )}

      {offer?.discountPercent ? (
        <p className="egghead-workshop-deal">
          Early bird: save {offer.discountPercent}%
          {offer.discountEndsAt ? (
            <>
              {" "}
              through{" "}
              {new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(
                new Date(offer.discountEndsAt),
              )}
            </>
          ) : null}
        </p>
      ) : null}

      <dl className="egghead-workshop-offer-facts">
        <div>
          <dt>When</dt>
          <dd>{formatWorkshopDate(workshop)}</dd>
        </div>
        <div>
          <dt>Format</dt>
          <dd>Live, hands-on, online</dd>
        </div>
        {offer?.seatsRemaining !== null && offer?.seatsRemaining !== undefined ? (
          <div>
            <dt>Seats</dt>
            <dd>{offer.soldOut ? "Sold out" : `${offer.seatsRemaining} remaining`}</dd>
          </div>
        ) : null}
        {offer?.conditionalOffer ? (
          <div>
            <dt>Eligible buyers</dt>
            <dd>
              {formatWorkshopPrice(offer.conditionalOffer.price)} after the qualifying purchase is
              verified
            </dd>
          </div>
        ) : null}
      </dl>

      {registration.type === "open" ? (
        <Link className="egghead-workshop-cta press" href={registration.href}>
          {registration.label}
          <span aria-hidden>→</span>
        </Link>
      ) : (
        <p className="egghead-workshop-registration-state">{registrationMessage(registration)}</p>
      )}
      <p className="egghead-workshop-fine-print">
        Member and coupon eligibility is confirmed during registration.
      </p>
    </aside>
  );
}

function registrationMessage(registration: Exclude<RegistrationState, { type: "open" }>) {
  const messages = {
    "sold-out": "This workshop is sold out.",
    closed: "Registration is closed.",
    pending: "Registration details are coming soon.",
  } satisfies Record<typeof registration.type, string>;
  return messages[registration.type];
}

export function WorkshopPage({ workshop }: { workshop: Workshop }) {
  return (
    <main>
      <section className="egghead-workshop-hero">
        <Container className="egghead-workshop-hero-grid" size="wide">
          <div className="egghead-workshop-intro">
            <Link className="egghead-workshop-back" href="/workshops">
              ← All workshops
            </Link>
            <p className="egghead-workshop-stamp">{STATUS_LABEL[workshop.status]}</p>
            <h1>{workshop.title}</h1>
            <p className="egghead-workshop-lede">{workshop.description}</p>
            <p className="egghead-workshop-date">{formatWorkshopDate(workshop)}</p>
          </div>

          {workshop.imageUrl ? (
            <div className="egghead-workshop-poster">
              <Image
                alt=""
                fill
                priority
                sizes="(max-width: 800px) 100vw, 48vw"
                src={workshop.imageUrl}
                unoptimized
              />
            </div>
          ) : (
            <div
              aria-hidden
              className="egghead-workshop-poster egghead-workshop-poster-placeholder"
            >
              <span>live</span>
              <strong>workshop</strong>
              <small>learn by doing</small>
            </div>
          )}
        </Container>
      </section>

      <Container className="egghead-workshop-body-grid" size="wide">
        <article className="egghead-workshop-copy">
          <p className="egghead-workshop-body-label">Workshop field guide</p>
          <MarkdownContent label={`${workshop.title} workshop details`}>
            {workshop.body}
          </MarkdownContent>
          {!workshop.body ? (
            <p className="egghead-empty-state">Full workshop details are coming soon.</p>
          ) : null}
        </article>
        <WorkshopOfferCard workshop={workshop} />
      </Container>
    </main>
  );
}
