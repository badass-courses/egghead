import { randomUUID } from "node:crypto";
import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { isPriceAvailable } from "@coursebuilder/commerce/select-product-price";
import type { Price } from "@coursebuilder/core/schemas/price-schema";
import {
  getLocalMembership,
  getLocalMembershipServices,
  isLocalMembershipEnabled,
  LOCAL_MEMBERSHIP_ID,
} from "./catalog";
import {
  checkoutMembership,
  refreshMembershipPrices,
  saveMembershipOffers,
} from "../app/local/membership/actions";
import styles from "./membership-page.module.css";

function cadence(price: Price) {
  const recurring = price.fields.stripe?.recurring;
  if (!recurring) return "one time";
  return recurring.intervalCount === 1
    ? `per ${recurring.interval}`
    : `every ${recurring.intervalCount} ${recurring.interval}s`;
}
function money(price: Price) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: price.fields.stripe?.currency ?? "usd",
    maximumFractionDigits: 2,
  }).format(price.unitAmount);
}

async function MembershipContent({
  searchParams,
  configuration,
}: {
  configuration: boolean;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  if (!isLocalMembershipEnabled()) notFound();
  const query = await searchParams;
  const product = await getLocalMembership();
  const prices = product.prices ?? [];
  const offered = prices
    .filter(isPriceAvailable)
    .toSorted((a, b) => (a.fields.offer?.position ?? 0) - (b.fields.offer?.position ?? 0));
  let notice = query["saved"]
    ? "Offer settings saved to the local database."
    : query["synced"]
      ? "Prices refreshed from Stripe. Your offer settings have been preserved."
      : query["cancelled"]
        ? "Checkout cancelled. Choose any billing option to try again."
        : "";
  if (query["error"] === "default-offered")
    notice = "Choose an offered price as the default before saving.";
  const sessionId = query["session_id"];
  if (typeof sessionId === "string" && sessionId.startsWith("cs_test_")) {
    const { payments } = getLocalMembershipServices();
    const session = await payments.stripe.checkout.sessions.retrieve(sessionId);
    if (
      !session.livemode &&
      session.client_reference_id === LOCAL_MEMBERSHIP_ID &&
      session.status === "complete"
    )
      notice =
        "Test checkout completed successfully. This local flow does not grant membership access.";
  }
  return (
    <main className={styles["page"]}>
      <header className={styles["header"]}>
        <p className={styles["eyebrow"]}>LOCAL TEST · STRIPE SANDBOX</p>
        <h1>{product.name}</h1>
        <p>One membership. Choose the billing schedule that works for you.</p>
      </header>
      {notice && <output className={styles["notice"]}>{notice}</output>}
      <form action={checkoutMembership}>
        <input type="hidden" name="requestId" value={randomUUID()} />
        <input
          type="hidden"
          name="returnPath"
          value={configuration ? "/local/membership" : "/pricing"}
        />
        <fieldset className={styles["options"]}>
          <legend className={styles["legend"]}>Choose a billing option</legend>
          {offered.map((price) => (
            <label className={styles["option"]} key={price.id}>
              <span className={styles["optionTop"]}>
                <span>{price.fields.offer?.label ?? cadence(price)}</span>
                <input
                  type="radio"
                  name="priceId"
                  aria-label={`Select ${price.fields.offer?.label ?? cadence(price)}`}
                  value={price.id}
                  defaultChecked={price.id === product.price?.id}
                  required
                />
              </span>
              <strong>{money(price)}</strong>
              <span>{cadence(price)}</span>
              {price.id === product.price?.id && <small>Default option</small>}
            </label>
          ))}
        </fieldset>
        {offered.length === 0 && (
          <p>Membership is currently unavailable. Please check back soon.</p>
        )}
        <button className={styles["primary"]} type="submit" disabled={offered.length === 0}>
          Continue to test checkout →
        </button>
        <p className={styles["hint"]}>
          Stripe test mode. No real payment is collected. Example prices are for local testing.
        </p>
      </form>
      {configuration && (
        <section className={styles["settings"]} aria-labelledby="settings-title">
          <div className={styles["sectionHeader"]}>
            <div>
              <p className={styles["eyebrow"]}>PRODUCT CONFIGURATION</p>
              <h2 id="settings-title">Available prices</h2>
              <p>{prices.length} prices synced from one Stripe product.</p>
            </div>
            <form action={refreshMembershipPrices}>
              <button className={styles["secondary"]} type="submit">
                Refresh from Stripe
              </button>
            </form>
          </div>
          <form action={saveMembershipOffers}>
            <div className={styles["tableWrap"]}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Offer</th>
                    <th scope="col">Label</th>
                    <th scope="col">Billing</th>
                    <th scope="col">Order</th>
                    <th scope="col">Default</th>
                  </tr>
                </thead>
                <tbody>
                  {prices.map((price) => (
                    <tr key={price.id}>
                      <td>
                        <input
                          aria-label={`Offer ${price.fields.offer?.label ?? cadence(price)}`}
                          type="checkbox"
                          name={`offered:${price.id}`}
                          defaultChecked={price.fields.offer?.offered}
                          disabled={!price.fields.stripe?.active || !price.fields.stripe.supported}
                        />
                      </td>
                      <td>
                        <input
                          aria-label={`Label for ${cadence(price)}`}
                          name={`label:${price.id}`}
                          defaultValue={price.fields.offer?.label ?? cadence(price)}
                          maxLength={100}
                          required
                        />
                      </td>
                      <td>
                        {money(price)} <span className={styles["hint"]}>{cadence(price)}</span>
                      </td>
                      <td>
                        <input
                          aria-label={`Order for ${cadence(price)}`}
                          type="number"
                          name={`position:${price.id}`}
                          min={0}
                          max={100}
                          defaultValue={price.fields.offer?.position ?? 0}
                          required
                        />
                      </td>
                      <td>
                        <input
                          aria-label={`Default ${price.fields.offer?.label ?? cadence(price)}`}
                          type="radio"
                          name="defaultPriceId"
                          value={price.id}
                          defaultChecked={price.id === product.price?.id}
                          required
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button className={styles["secondary"]} type="submit">
              Save offer settings
            </button>
            <p className={styles["hint"]}>
              Labels, order, availability, and default are stored locally. Amounts and billing
              intervals come from Stripe.
            </p>
          </form>
        </section>
      )}
    </main>
  );
}
export function MembershipPage(props: {
  configuration: boolean;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<main className={styles["page"]}>Loading membership prices…</main>}>
      <MembershipContent {...props} />
    </Suspense>
  );
}
