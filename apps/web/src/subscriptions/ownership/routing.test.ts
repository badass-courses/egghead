import { describe, expect, it } from "vitest";

import { ownerMarkerMetadata, parseTimeline, readOwnerMarker, type OwnerMarker } from "./marker";
import {
  cbPaymentIntentFlag,
  checkoutCustomerDecision,
  isAccountLevelEvent,
  routeStripeEvent,
  shouldAct,
  type EventOwnershipStamp,
  type EventSubject,
  type RouteDecision,
} from "./routing";

const NOW = 1_800_000_000;
const FLIP = NOW + 900;
const TTL = 60;

const before = readOwnerMarker({});
const after = readOwnerMarker(ownerMarkerMetadata(parseTimeline(`rails@0;cb@${FLIP}`) ?? [], 1));

function route(
  subject: EventSubject,
  eventCreated: number,
  priorStamp: EventOwnershipStamp | null = null,
): RouteDecision {
  return routeStripeEvent({
    eventId: "evt_1",
    eventCreated,
    subject,
    receivedAt: eventCreated + 1,
    priorStamp,
  });
}

function ownerOf(decision: RouteDecision) {
  if (decision.scope !== "owned") throw new Error("expected an owned decision");
  return decision.owner;
}

function customer(marker: OwnerMarker): EventSubject {
  return { kind: "customer", marker };
}

describe("routing at receipt", () => {
  it("routes every customer-scoped event by the customer's timeline", () => {
    // customer.*, payment_method.*, invoices without a subscription and subscription
    // events all carry a customer, so they all route the same way.
    expect(ownerOf(route(customer(after), FLIP - 1))).toBe("rails");
    expect(ownerOf(route(customer(after), FLIP))).toBe("cb");
    expect(ownerOf(route(customer(before), FLIP + 10))).toBe("rails");
  });

  it("stamps the decision once and reuses it on redelivery", () => {
    const first = route(customer(before), FLIP + 10);
    if (first.scope !== "owned") throw new Error("expected owned");
    expect(first.stampIsNew).toBe(true);
    expect(first.stamp).toEqual({
      eventId: "evt_1",
      owner: "rails",
      basis: "customer_timeline",
      markerGeneration: 0,
      decidedAt: FLIP + 11,
    });
    // Redelivered after the marker changed: the stamp holds.
    const again = route(customer(after), FLIP + 10, first.stamp);
    expect(again).toEqual({
      scope: "owned",
      owner: "rails",
      stamp: first.stamp,
      stampIsNew: false,
    });
    expect(shouldAct(again, "rails")).toBe(true);
    expect(shouldAct(again, "cb")).toBe(false);
  });
});

describe("events without a live customer (10, 11, 12)", () => {
  it("routes guest charges and payment intents by the PaymentIntent flag", () => {
    const flagged = route(
      { kind: "customerless", paymentIntentMetadata: cbPaymentIntentFlag() },
      NOW,
    );
    if (flagged.scope !== "owned") throw new Error("expected owned");
    expect(flagged.stamp).toMatchObject({
      owner: "cb",
      basis: "payment_intent_flag",
      markerGeneration: null,
    });
    for (const metadata of [{}, { egghead_owner: "CB" }, null, "cb"]) {
      const unflagged = route({ kind: "customerless", paymentIntentMetadata: metadata }, NOW);
      if (unflagged.scope !== "owned") throw new Error("expected owned");
      expect(unflagged.stamp).toMatchObject({ owner: "rails", basis: "no_owner_marker" });
    }
  });

  it("leaves account-level events to each app, as today", () => {
    for (const type of [
      "product.updated",
      "price.created",
      "plan.deleted",
      "coupon.updated",
      "promotion_code.created",
      "tax_rate.updated",
    ]) {
      expect(isAccountLevelEvent(type), type).toBe(true);
    }
    for (const type of [
      "customer.updated",
      "charge.succeeded",
      "invoice.paid",
      "payment_method.attached",
    ]) {
      expect(isAccountLevelEvent(type), type).toBe(false);
    }
    const decision = route({ kind: "account_level" }, NOW);
    expect(decision).toEqual({ scope: "account_level" });
    expect(shouldAct(decision, "cb")).toBe("as_today");
    expect(shouldAct(decision, "rails")).toBe("as_today");
  });

  it("routes a deleted customer by the recorded timeline, else to rails", () => {
    const known = parseTimeline(`cb@0`) ?? [];
    const recorded = route({ kind: "deleted_customer", knownTimeline: known }, NOW);
    if (recorded.scope !== "owned") throw new Error("expected owned");
    expect(recorded.stamp).toMatchObject({ owner: "cb", basis: "deleted_customer_record" });
    const unknown = route({ kind: "deleted_customer", knownTimeline: null }, NOW);
    if (unknown.scope !== "owned") throw new Error("expected owned");
    expect(unknown.stamp).toMatchObject({ owner: "rails", basis: "no_owner_marker" });
  });
});

describe("the double-act window, modelled", () => {
  // Each app reads the marker at receipt from a cache fetched at most TTL earlier. A
  // reader sees the flip only if the write landed at or before its fetch.
  function decide(created: number, receivedAt: number, cacheAge: number, landedAt: number) {
    const fetchedAt = receivedAt - cacheAge;
    return ownerOf(route(customer(fetchedAt >= landedAt ? after : before), created));
  }

  const createdTimes = [FLIP - 120, FLIP - 1, FLIP, FLIP + 1, FLIP + 30, FLIP + 120];
  const delays = [0, 1, 5, 59, 600, 3 * 86_400];
  const cacheAges = [0, 30, TTL];

  it("gives both apps the same answer whenever the write lands by flipAt - TTL", () => {
    for (const landedAt of [NOW, FLIP - TTL - 120, FLIP - TTL]) {
      for (const created of createdTimes) {
        const answers = new Set<string>();
        for (const delay of delays) {
          for (const age of cacheAges) answers.add(decide(created, created + delay, age, landedAt));
        }
        expect([...answers], `created ${created}, landed ${landedAt}`).toHaveLength(1);
      }
    }
  });

  it("can split when the write lands late: the window the ADR names", () => {
    const landedAt = FLIP + 30;
    expect(decide(FLIP + 1, FLIP + 1, 0, landedAt)).toBe("rails");
    expect(decide(FLIP + 1, FLIP + 600, 0, landedAt)).toBe("cb");
    expect(decide(landedAt + TTL, landedAt + TTL, TTL, landedAt)).toBe("cb");
    expect(decide(FLIP - 1, FLIP + 600, 0, landedAt)).toBe("rails");
  });
});

describe("CB checkout on an existing customer (refuse unless CB owns it)", () => {
  it("creates a CB-born customer when there is none", () => {
    expect(checkoutCustomerDecision({ customerMarker: null, now: NOW })).toEqual({
      action: "create_cb_customer",
      metadata: {
        egghead_owner: "cb",
        egghead_owner_timeline: "cb@0",
        egghead_owner_generation: "1",
      },
    });
    expect(cbPaymentIntentFlag()).toEqual({ egghead_owner: "cb" });
  });

  it("proceeds only when CB owns the customer now and after every scheduled flip", () => {
    expect(checkoutCustomerDecision({ customerMarker: after, now: FLIP })).toEqual({
      action: "proceed",
    });
    expect(checkoutCustomerDecision({ customerMarker: after, now: FLIP - 1 })).toEqual({
      action: "refuse",
      reason: "customer_flip_scheduled",
    });
    expect(checkoutCustomerDecision({ customerMarker: before, now: NOW })).toEqual({
      action: "refuse",
      reason: "customer_owned_by_rails",
    });
    const handbackScheduled = readOwnerMarker(
      ownerMarkerMetadata(parseTimeline(`rails@0;cb@${NOW - 100};rails@${FLIP}`) ?? [], 3),
    );
    expect(checkoutCustomerDecision({ customerMarker: handbackScheduled, now: NOW })).toEqual({
      action: "refuse",
      reason: "customer_owned_by_rails",
    });
    expect(
      checkoutCustomerDecision({
        customerMarker: readOwnerMarker({ egghead_owner: "cb" }),
        now: NOW,
      }),
    ).toEqual({ action: "refuse", reason: "marker_unrecognized" });
  });
});
