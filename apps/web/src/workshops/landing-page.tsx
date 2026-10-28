import Image from "next/image";
import Link from "next/link";
import { Button } from "@egghead/ui/button";
import type { Workshop } from "@egghead/core/contracts";
import { randomUUID } from "node:crypto";
import type { WorkshopPurchaseOffer } from "./catalog";
import { startWorkshopCheckout } from "./checkout";

import { workshopInstructorImage } from "./instructor-image";

import styles from "./landing-page.module.css";

export function WorkshopLandingPage({
  workshop,
  offer,
  checkoutAvailable = false,
  preview = true,
}: {
  workshop: Workshop;
  offer?: WorkshopPurchaseOffer | null;
  checkoutAvailable?: boolean;
  preview?: boolean;
}) {
  const { fields } = workshop;
  const landing = fields.landingPage;
  const instructorImage = workshopInstructorImage(landing?.instructor.imageUrl);
  const introduction = landing?.introduction ?? fields.description;
  const purchasable = fields.state === "published" && checkoutAvailable && Boolean(offer);
  const fractionDigits = offer && Number.isInteger(offer.unitAmount) ? 0 : 2;
  const price = offer
    ? `${new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: offer.currency,
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      }).format(offer.unitAmount)} USD`
    : null;
  const startsAt = new Date(fields.startsAt);
  const date = new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeZone: fields.timezone,
  }).format(startsAt);
  const clock = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: fields.timezone,
  });
  const start = clock.format(startsAt);
  const end = clock.format(new Date(fields.endsAt));
  const zone =
    new Intl.DateTimeFormat("en-US", { timeZone: fields.timezone, timeZoneName: "long" })
      .formatToParts(startsAt)
      .find((part) => part.type === "timeZoneName")?.value ?? fields.timezone;

  return (
    <main
      className={purchasable ? `${styles["page"]} ${styles["pageWithCheckout"]}` : styles["page"]}
    >
      {preview ? (
        <aside className={styles["preview"]}>
          <span>
            {fields.state === "draft" ? "Draft preview · Unlisted" : "Published workshop preview"}
          </span>
          <Link href="/local/workshops">All workshop drafts</Link>
        </aside>
      ) : null}

      <div className={styles["layout"]}>
        <header className={styles["hero"]}>
          <h1>{landing?.headline ?? fields.title}</h1>
          {landing ? (
            <p className={styles["byline"]}>
              {instructorImage ? (
                <Image {...instructorImage} alt="" height={80} width={80} />
              ) : null}
              <span>
                With <a href="#instructor">{landing.instructor.name}</a>
              </span>
            </p>
          ) : null}
        </header>

        {/* The same checkout form sits in the desktop ticket and anchors to the mobile viewport. */}
        <div className={styles["registrationColumn"]}>
          <section
            aria-labelledby="workshop-details-title"
            className={styles["ticket"]}
            id="workshop-details"
          >
            <h2 id="workshop-details-title">
              {landing ? fields.title : "Schedule and registration"}
            </h2>
            <dl className={styles["facts"]}>
              <div>
                <dt>Date</dt>
                <dd>
                  <time dateTime={fields.startsAt}>{date}</time>
                </dd>
              </div>
              <div>
                <dt>Time</dt>
                <dd>
                  <time dateTime={fields.startsAt}>{start}</time>–
                  <time dateTime={fields.endsAt}>{end}</time>
                  <span>{zone}</span>
                </dd>
              </div>
            </dl>
            {purchasable ? null : (
              <div className={styles["registration"]}>
                {price ? (
                  <p className={styles["price"]}>
                    {price}
                    <span>One-time workshop ticket</span>
                  </p>
                ) : null}
                <div className={styles["status"]}>
                  <p>
                    <strong>
                      {fields.state === "draft"
                        ? "Registration opens when published"
                        : "Registration is unavailable"}
                    </strong>
                  </p>
                  <p>
                    {fields.state === "draft"
                      ? "This workshop is still a draft. Registration will open when it is published."
                      : "Registration is currently closed. Please check back for availability."}
                  </p>
                </div>
              </div>
            )}
          </section>

          {purchasable ? (
            <form action={startWorkshopCheckout} className={styles["checkout"]}>
              <input name="workshopId" type="hidden" value={workshop.id} />
              <input name="requestId" type="hidden" value={randomUUID()} />
              {price ? (
                <p className={styles["price"]}>
                  {price}
                  <span>One-time workshop ticket</span>
                </p>
              ) : null}
              <Button className={`w-full ${styles["buy"]}`} size="lg" type="submit">
                Buy your seat
              </Button>
              <p className={styles["caption"]}>Secure payment through Stripe.</p>
            </form>
          ) : null}
        </div>

        <div className={styles["story"]}>
          {introduction ? <p className={styles["introduction"]}>{introduction}</p> : null}

          {landing?.sections.map((section) => (
            <section className={styles["section"]} key={section.heading}>
              <h2>{section.heading}</h2>
              <p>{section.body}</p>
              {section.bullets.length ? (
                <ul>
                  {section.bullets.map((bullet) => (
                    <li key={bullet}>{bullet}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}

          {landing ? (
            <>
              <section className={styles["section"]}>
                <h2>What you’ll leave with</h2>
                <ul>
                  {landing.takeaways.map((takeaway) => (
                    <li key={takeaway}>{takeaway}</li>
                  ))}
                </ul>
              </section>

              <section className={styles["instructor"]} id="instructor">
                {instructorImage ? (
                  <Image
                    {...instructorImage}
                    alt={landing.instructor.name}
                    className={styles["portrait"]}
                    height={192}
                    width={192}
                  />
                ) : null}
                <div>
                  <h2>{landing.instructor.name}</h2>
                  <p className={styles["role"]}>{landing.instructor.role}</p>
                  <p>{landing.instructor.biography}</p>
                </div>
              </section>
            </>
          ) : null}

          {fields.attendeeInstructions ? (
            <section className={styles["section"]}>
              <h2>Before the workshop</h2>
              <p className={styles["instructions"]}>{fields.attendeeInstructions}</p>
            </section>
          ) : null}

          {landing?.questions.length ? (
            <section className={styles["section"]}>
              <h2>Questions</h2>
              <div className={styles["questions"]}>
                {landing.questions.map(({ question, answer }) => (
                  <details key={question}>
                    <summary>{question}</summary>
                    <p>{answer}</p>
                  </details>
                ))}
              </div>
            </section>
          ) : null}

          <p className={styles["backLink"]}>
            <a href="#workshop-details">Schedule and registration</a>
          </p>
        </div>
      </div>
    </main>
  );
}
