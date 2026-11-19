import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  appendFlip,
  cbBornCustomerMetadata,
  compactTimeline,
  finalOwner,
  MAX_TIMELINE_ENTRIES,
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

const vectorsSchema = z.object({
  parse: z.array(
    z.object({
      name: z.string(),
      metadata: z.unknown(),
      source: z.enum(["explicit", "absent", "unrecognized"]),
      routedTimeline: z.string(),
      generation: z.number(),
    }),
  ),
  ownerAt: z.array(
    z.object({ timeline: z.string(), created: z.number(), owner: z.enum(["rails", "cb"]) }),
  ),
});

const vectors = vectorsSchema.parse(
  JSON.parse(readFileSync(new URL("./timeline-vectors.json", import.meta.url), "utf8")),
);

describe("shared vectors (Rails specs load the same file)", () => {
  for (const vector of vectors.parse) {
    it(`parses: ${vector.name}`, () => {
      const marker = readOwnerMarker(vector.metadata);
      expect(serializeTimeline(marker.timeline)).toBe(vector.routedTimeline);
      expect(marker.source).toBe(vector.source);
      expect(marker.generation).toBe(vector.generation);
    });
  }

  for (const vector of vectors.ownerAt) {
    it(`routes ${vector.timeline} at ${vector.created}`, () => {
      expect(ownerAt(parseTimeline(vector.timeline) ?? [], vector.created)).toBe(vector.owner);
    });
  }

  it("covers both the valid and the invalid shapes", () => {
    expect(vectors.parse.some((vector) => vector.source === "unrecognized")).toBe(true);
    expect(vectors.parse.some((vector) => vector.source === "explicit")).toBe(true);
    expect(vectors.parse.some((vector) => vector.source === "absent")).toBe(true);
  });
});

describe("readOwnerMarker", () => {
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
  });

  it("marks customers CB creates as CB-owned from their first event", () => {
    expect(cbBornCustomerMetadata()).toEqual({
      egghead_owner: "cb",
      egghead_owner_timeline: "cb@0",
      egghead_owner_generation: "1",
    });
  });

  it("routes by the event's Stripe created time", () => {
    const timeline = parseTimeline(`rails@0;cb@${NOW};rails@${NOW + DAY}`) ?? [];
    expect(ownerAt(timeline, NOW - 1)).toBe("rails");
    expect(ownerAt(timeline, NOW)).toBe("cb");
    expect(finalOwner(timeline)).toBe("rails");
    expect(ownerAt([], NOW)).toBe("rails");
  });
});

describe("compaction and appending", () => {
  it("never drops an entry younger than retention", () => {
    const timeline = parseTimeline(`rails@0;cb@${NOW - 10 * DAY};rails@${NOW - DAY}`) ?? [];
    expect(compactTimeline(timeline, NOW, 35 * DAY)).toEqual(timeline);
  });

  it("drops entries older than retention and restarts the first at 0", () => {
    const timeline = parseTimeline(`rails@0;cb@${NOW - 40 * DAY};rails@${NOW - DAY}`) ?? [];
    expect(serializeTimeline(compactTimeline(timeline, NOW, 35 * DAY))).toBe(
      `cb@0;rails@${NOW - DAY}`,
    );
    expect(compactTimeline([], NOW, DAY)).toEqual(RAILS_FROM_START);
  });

  it("appends a flip after the last entry and refuses a full or out-of-order timeline", () => {
    expect(appendFlip(RAILS_FROM_START, "cb", NOW, NOW - 900, 35 * DAY)).toEqual({
      ok: true,
      timeline: [
        { owner: "rails", since: 0 },
        { owner: "cb", since: NOW },
      ],
    });
    expect(appendFlip(RAILS_FROM_START, "rails", NOW, NOW, 35 * DAY)).toEqual({
      ok: false,
      reason: "already_final_owner",
    });
    const scheduled = parseTimeline(`rails@0;cb@${NOW + 100}`) ?? [];
    expect(appendFlip(scheduled, "rails", NOW + 50, NOW, 35 * DAY)).toEqual({
      ok: false,
      reason: "flip_not_after_last",
    });
    const busy = Array.from({ length: MAX_TIMELINE_ENTRIES }, (_, i) => ({
      owner: i % 2 === 0 ? ("rails" as const) : ("cb" as const),
      since: i === 0 ? 0 : NOW - 100 + i,
    }));
    expect(appendFlip(busy, "rails", NOW + 900, NOW, 35 * DAY)).toEqual({
      ok: false,
      reason: "timeline_full",
    });
  });
});

describe("idempotency keys", () => {
  it("builds keys from customer, generation and nonce", () => {
    expect(ownerMarkerIdempotencyKey("cus_1", 3, 0)).toBe("egghead-owner:cus_1:3:0");
    expect(ownerMarkerIdempotencyKey("cus_1", 3, 1)).not.toBe(
      ownerMarkerIdempotencyKey("cus_1", 3, 0),
    );
  });
});
