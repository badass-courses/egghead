import { describe, expect, it } from "vitest";

import {
  appendFlip,
  cbBornCustomerMetadata,
  compactTimeline,
  finalOwner,
  MAX_TIMELINE_ENTRIES,
  oneTimePaymentOwner,
  ownerAt,
  ownerMarkerIdempotencyKey,
  ownerMarkerMetadata,
  parseTimeline,
  RAILS_FROM_START,
  readOwnerMarker,
  serializeTimeline,
} from "./marker";

const DAY = 86_400;
const NOW = 1_800_000_000;

describe("timeline parsing (Rails mirrors these rules)", () => {
  it("accepts alternating owners from 0 with increasing times", () => {
    expect(parseTimeline("rails@0;cb@1800000900;rails@1800100000")).toEqual([
      { owner: "rails", since: 0 },
      { owner: "cb", since: 1_800_000_900 },
      { owner: "rails", since: 1_800_100_000 },
    ]);
    expect(parseTimeline("cb@0")).toEqual([{ owner: "cb", since: 0 }]);
  });

  it("rejects anything else", () => {
    for (const raw of [
      "",
      "cb@5",
      "rails@0;rails@10",
      "rails@0;cb@10;rails@10",
      "rails@0;cb@-1",
      "rails@0;CB@10",
      "rails@0,cb@10",
      "rails@0;cb@1234567890123",
      " rails@0",
      Array.from(
        { length: MAX_TIMELINE_ENTRIES + 1 },
        (_, i) => `${i % 2 === 0 ? "rails" : "cb"}@${i}`,
      ).join(";"),
    ]) {
      expect(parseTimeline(raw), raw).toBeNull();
    }
  });
});

describe("readOwnerMarker", () => {
  it("routes a missing marker to rails", () => {
    expect(readOwnerMarker({})).toEqual({
      timeline: RAILS_FROM_START,
      generation: 0,
      source: "absent",
      mirrorMismatch: false,
    });
    expect(readOwnerMarker(null).source).toBe("absent");
    expect(readOwnerMarker("cb").source).toBe("absent");
  });

  it("treats a bare owner key or a garbled timeline as unrecognized rails", () => {
    expect(readOwnerMarker({ egghead_owner: "cb" })).toMatchObject({
      timeline: RAILS_FROM_START,
      source: "unrecognized",
    });
    expect(readOwnerMarker({ egghead_owner_timeline: "cb@0;cb@9" })).toMatchObject({
      timeline: RAILS_FROM_START,
      source: "unrecognized",
    });
  });

  it("reads a written marker back and flags a mirror that disagrees", () => {
    const timeline = [
      { owner: "rails" as const, since: 0 },
      { owner: "cb" as const, since: NOW },
    ];
    expect(readOwnerMarker(ownerMarkerMetadata(timeline, 4))).toEqual({
      timeline,
      generation: 4,
      source: "explicit",
      mirrorMismatch: false,
    });
    expect(
      readOwnerMarker({ ...ownerMarkerMetadata(timeline, 4), egghead_owner: "rails" })
        .mirrorMismatch,
    ).toBe(true);
    expect(
      readOwnerMarker({ ...ownerMarkerMetadata(timeline, 4), egghead_owner_generation: "x" })
        .generation,
    ).toBe(0);
  });

  it("marks customers CB creates as CB-owned from their first event", () => {
    expect(cbBornCustomerMetadata()).toEqual({
      egghead_owner: "cb",
      egghead_owner_timeline: "cb@0",
      egghead_owner_generation: "1",
    });
  });
});

describe("ownerAt", () => {
  const timeline = parseTimeline(`rails@0;cb@${NOW};rails@${NOW + DAY}`) ?? [];

  it("routes by the event's Stripe created time", () => {
    expect(ownerAt(timeline, 0)).toBe("rails");
    expect(ownerAt(timeline, NOW - 1)).toBe("rails");
    expect(ownerAt(timeline, NOW)).toBe("cb");
    expect(ownerAt(timeline, NOW + DAY - 1)).toBe("cb");
    expect(ownerAt(timeline, NOW + DAY)).toBe("rails");
    expect(finalOwner(timeline)).toBe("rails");
    expect(ownerAt([], NOW)).toBe("rails");
  });
});

describe("compaction and appending", () => {
  it("drops entries older than retention and restarts the first at 0", () => {
    const timeline = parseTimeline(`rails@0;cb@${NOW - 10 * DAY};rails@${NOW - DAY}`) ?? [];
    expect(serializeTimeline(compactTimeline(timeline, NOW, 7 * DAY))).toBe(
      `cb@0;rails@${NOW - DAY}`,
    );
    expect(compactTimeline(timeline, NOW, 30 * DAY)).toEqual(timeline);
    expect(compactTimeline([], NOW, DAY)).toEqual(RAILS_FROM_START);
  });

  it("appends a flip after the last entry and refuses a full or out-of-order timeline", () => {
    expect(appendFlip(RAILS_FROM_START, "cb", NOW, NOW - 900, 7 * DAY)).toEqual({
      ok: true,
      timeline: [
        { owner: "rails", since: 0 },
        { owner: "cb", since: NOW },
      ],
    });
    expect(appendFlip(RAILS_FROM_START, "rails", NOW, NOW, 7 * DAY)).toEqual({
      ok: false,
      reason: "already_final_owner",
    });
    const scheduled = parseTimeline(`rails@0;cb@${NOW + 100}`) ?? [];
    expect(appendFlip(scheduled, "rails", NOW + 50, NOW, 7 * DAY)).toEqual({
      ok: false,
      reason: "flip_not_after_last",
    });
    const busy = Array.from({ length: MAX_TIMELINE_ENTRIES }, (_, i) => ({
      owner: i % 2 === 0 ? ("rails" as const) : ("cb" as const),
      since: i === 0 ? 0 : NOW - 100 + i,
    }));
    expect(appendFlip(busy, "rails", NOW + 900, NOW, 7 * DAY)).toEqual({
      ok: false,
      reason: "timeline_full",
    });
  });
});

describe("keys and one-time payments", () => {
  it("builds idempotency keys from customer, generation and nonce", () => {
    expect(ownerMarkerIdempotencyKey("cus_1", 3, 0)).toBe("egghead-owner:cus_1:3:0");
    expect(ownerMarkerIdempotencyKey("cus_1", 3, 1)).not.toBe(
      ownerMarkerIdempotencyKey("cus_1", 3, 0),
    );
  });

  it("routes customerless payments by the session flag", () => {
    expect(oneTimePaymentOwner({ egghead_owner: "cb" })).toBe("cb");
    expect(oneTimePaymentOwner({ egghead_owner: "CB" })).toBe("rails");
    expect(oneTimePaymentOwner(undefined)).toBe("rails");
  });
});
