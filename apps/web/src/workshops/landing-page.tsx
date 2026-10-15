import Image from "next/image";
import Link from "next/link";
import type { Workshop } from "@egghead/core/contracts";
import { randomUUID } from "node:crypto";
import type { WorkshopPurchaseOffer } from "./catalog";
import { startWorkshopCheckout } from "./checkout";

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
  const price = offer
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: offer.currency,
        maximumFractionDigits: 2,
      }).format(offer.unitAmount) + " USD"
    : null;
  const date = new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeZone: fields.timezone,
  }).format(new Date(fields.startsAt));
  const clock = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: fields.timezone,
    timeZoneName: "short",
  });
  const start = clock.format(new Date(fields.startsAt));
  const end = clock.format(new Date(fields.endsAt));
  return (
    <main className={styles["page"]}>
      {preview ? (
        <aside className={styles["preview"]}>
          <span>
            {fields.state === "draft" ? "Draft preview · Unlisted" : "Published workshop preview"}
          </span>
          <Link href="/local/workshops">All workshop drafts</Link>
        </aside>
      ) : null}

      <header className={styles["hero"]}>
        <h1>{landing?.headline ?? fields.title}</h1>
        <p className={styles["introduction"]}>{landing?.introduction ?? fields.description}</p>
        {landing ? (
          <a className={styles["presenter"]} href="#instructor">
            {landing.instructor.imageUrl ? (
              <Image alt="" height={40} src={landing.instructor.imageUrl} width={40} />
            ) : null}
            <span>
              With <strong>{landing.instructor.name}</strong>
            </span>
          </a>
        ) : null}
        <p className={styles["heroDate"]}>
          {date} · {start}–{end}
        </p>
        <a className={styles["cta"]} href="#workshop-details">
          See workshop details <span aria-hidden="true">↓</span>
        </a>
      </header>

      <div className={styles["story"]}>
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
            <section className={styles["instructor"]} id="instructor">
              {landing.instructor.imageUrl ? (
                <Image
                  alt={landing.instructor.name}
                  className={styles["portrait"]}
                  height={256}
                  src={landing.instructor.imageUrl}
                  width={256}
                />
              ) : null}
              <div>
                <h2>{landing.instructor.name}</h2>
                <p className={styles["instructorRole"]}>{landing.instructor.role}</p>
                <p>{landing.instructor.biography}</p>
              </div>
            </section>

            <section className={styles["section"]}>
              <h2>Leave with a workflow you can keep building on.</h2>
              <p>
                A day of building is useful. A process you can bring back to your own projects is
                even better.
              </p>
              <ul className={styles["takeaways"]}>
                {landing.takeaways.map((takeaway) => (
                  <li key={takeaway}>{takeaway}</li>
                ))}
              </ul>
            </section>
          </>
        ) : null}

        <section className={styles["details"]} id="workshop-details">
          <h2>Make a day of it.</h2>
          <p>{fields.title}</p>
          <dl className={styles["schedule"]}>
            <div>
              <dt>When</dt>
              <dd>
                <time dateTime={fields.startsAt}>{date}</time>
              </dd>
            </div>
            <div>
              <dt>Time</dt>
              <dd>
                {start}–{end}
              </dd>
            </div>
          </dl>
          <div className={styles["registration"]}>
            {price ? (
              <p className={styles["price"]}>
                {price}
                <span>One-time workshop ticket</span>
              </p>
            ) : null}
            {fields.state === "published" && checkoutAvailable && offer ? (
              <form action={startWorkshopCheckout}>
                <input name="workshopId" type="hidden" value={workshop.id} />
                <input name="requestId" type="hidden" value={randomUUID()} />
                <button className={styles["cta"]} type="submit">
                  Buy your seat · {price}
                </button>
                <p>Secure payment through Stripe.</p>
              </form>
            ) : (
              <>
                <h3>
                  {fields.state === "draft"
                    ? "Registration opens when published"
                    : "Registration is unavailable"}
                </h3>
                <p>
                  {fields.state === "draft"
                    ? "This workshop is still a draft. Registration will open when it is published."
                    : "Registration is currently closed. Please check back for availability."}
                </p>
              </>
            )}
          </div>
        </section>

        {fields.attendeeInstructions ? (
          <section className={styles["section"]}>
            <h2>Come ready to build.</h2>
            <p className={styles["instructions"]}>{fields.attendeeInstructions}</p>
          </section>
        ) : null}

        {landing?.questions.length ? (
          <section className={styles["section"]}>
            <h2>A few things to know.</h2>
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
      </div>
    </main>
  );
}
