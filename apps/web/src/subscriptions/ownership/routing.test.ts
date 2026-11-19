import { describe, expect, it } from "vitest";

import { ownerMarkerMetadata, parseTimeline, readOwnerMarker, type OwnerMarker } from "./marker";
import {
  checkoutCustomerDecision,
  routeStripeEvent,
  shouldAct,
  type EventOwnershipStamp,
} from "./routing";

const NOW = 1_800_000_000;
const FLIP = NOW + 900;
const TTL = 60;

const before = readOwnerMarker({});
const after = readOwnerMarker(ownerMarkerMetadata(parseTimeline(`rails@0;cb@${FLIP}`) ?? [], 1));

function route(
  customerMarker: OwnerMarker | null,
  eventCreated: number,
  priorStamp: EventOwnershipStamp | null = null,
) {
  return routeStripeEvent({
    eventId: "evt_1",
    eventCreated,
    customerMarker,
    checkoutSessionMetadata: undefined,
    receivedAt: eventCreated + 1,
    priorStamp,
  });
}

describe("routing at receipt", () => {
  it("routes every customer-scoped event by the customer's timeline", () => {
    // customer.*, payment_method.*, invoices without a subscription and subscription
    // events all carry a customer, so they all route the same way.
    expect(route(after, FLIP - 1).owner).toBe("rails");
    expect(route(after, FLIP).owner).toBe("cb");
    expect(route(before, FLIP + 10).owner).toBe("rails");
  });

  it("stamps the decision once and reuses it on redelivery", () => {
    const first = route(before, FLIP + 10);
    expect(first).toMatchObject({ stampIsNew: true, owner: "rails" });
    expect(first.stamp).toEqual({
      eventId: "evt_1",
      owner: "rails",
      basis: "customer_timeline",
      markerGeneration: 0,
      decidedAt: FLIP + 11,
    });
    // Redelivered after the marker changed: the stamp holds, so deferred work and
    // retries never change sides mid-event.
    const again = route(after, FLIP + 10, first.stamp);
    expect(again).toEqual({ owner: "rails", stamp: first.stamp, stampIsNew: false });
    expect(shouldAct(again, "rails")).toBe(true);
    expect(shouldAct(again, "cb")).toBe(false);
  });

  it("routes customerless events by the checkout session, else to rails", () => {
    const sessionEvent = routeStripeEvent({
      eventId: "evt_2",
      eventCreated: NOW,
      customerMarker: null,
      checkoutSessionMetadata: { egghead_owner: "cb" },
      receivedAt: NOW,
      priorStamp: null,
    });
    expect(sessionEvent.stamp).toMatchObject({
      owner: "cb",
      basis: "checkout_session",
      markerGeneration: null,
    });
    expect(route(null, NOW).stamp).toMatchObject({ owner: "rails", basis: "no_owner_marker" });
  });
});

describe("the double-act window, modelled", () => {
  // Each app reads the marker at receipt from a cache fetched at most TTL earlier. A
  // reader sees the flip only if the write landed at or before its fetch.
  function decide(created: number, receivedAt: number, cacheAge: number, landedAt: number) {
    const fetchedAt = receivedAt - cacheAge;
    return route(fetchedAt >= landedAt ? after : before, created).owner;
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
    const early = decide(FLIP + 1, FLIP + 1, 0, landedAt);
    const late = decide(FLIP + 1, FLIP + 600, 0, landedAt);
    expect(early).toBe("rails");
    expect(late).toBe("cb");
    // Outside [flipAt, landedAt + TTL) the answers agree again.
    expect(decide(landedAt + TTL, landedAt + TTL, TTL, landedAt)).toBe("cb");
    expect(decide(FLIP - 1, FLIP + 600, 0, landedAt)).toBe("rails");
  });
});

describe("CB checkout on an existing customer (desk pick: refuse unless CB owns it)", () => {
  it("creates a CB-born customer when there is none", () => {
    expect(checkoutCustomerDecision({ customerMarker: null, now: NOW })).toEqual({
      action: "create_cb_customer",
      metadata: {
        egghead_owner: "cb",
        egghead_owner_timeline: "cb@0",
        egghead_owner_generation: "1",
      },
    });
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
