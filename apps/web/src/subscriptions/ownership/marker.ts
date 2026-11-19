// The ownership marker lives on the Stripe *customer* as metadata. A customer moves
// as a whole: every subscription, invoice, charge and payment method on it follows the
// same owner. Both Rails and CourseBuilder parse the same keys with the same rules, so
// they route every event the same way. See docs/adr/0001-subscription-ownership-handover.md.
//
// `egghead_owner_timeline` is the routing fact: `owner@since` entries joined by `;`,
// `since` in epoch seconds on Stripe's clock. The owner of an event is the owner of the
// last entry whose `since` is at or before the event's `created`. A flip is written
// minutes before it takes effect, so both apps read it before any event it governs.
//
// Parse rules (Rails must mirror them exactly):
// - 1 to MAX_TIMELINE_ENTRIES entries, each `(rails|cb)@<1-12 digits>`;
// - the first `since` is 0, `since` strictly increases, and owners alternate;
// - anything else, including a missing timeline, routes every event to Rails.

export const OWNER_METADATA_KEY = "egghead_owner";
export const OWNER_TIMELINE_METADATA_KEY = "egghead_owner_timeline";
export const OWNER_GENERATION_METADATA_KEY = "egghead_owner_generation";
export const MAX_TIMELINE_ENTRIES = 8;

export type Owner = "rails" | "cb";

export interface TimelineEntry {
  readonly owner: Owner;
  /** Epoch seconds, compared with Stripe `event.created`. */
  readonly since: number;
}

export type OwnerTimeline = readonly TimelineEntry[];

export type OwnerMarkerSource = "explicit" | "absent" | "unrecognized";

export interface OwnerMarker {
  readonly timeline: OwnerTimeline;
  /** CB write counter. Identifies which write landed; never used for routing. */
  readonly generation: number;
  readonly source: OwnerMarkerSource;
  /** `egghead_owner` disagrees with the timeline's last owner. Routing ignores it. */
  readonly mirrorMismatch: boolean;
}

export const RAILS_FROM_START: OwnerTimeline = [{ owner: "rails", since: 0 }];
export const CB_FROM_START: OwnerTimeline = [{ owner: "cb", since: 0 }];

const entryPattern = /^(rails|cb)@(\d{1,12})$/;
const generationPattern = /^\d{1,15}$/;

function readStringField(metadata: object, key: string): string | undefined {
  const value: unknown = Reflect.get(metadata, key);
  return typeof value === "string" ? value : undefined;
}

export function parseTimeline(raw: string): TimelineEntry[] | null {
  const parts = raw.split(";");
  if (parts.length > MAX_TIMELINE_ENTRIES) return null;
  const entries: TimelineEntry[] = [];
  for (const part of parts) {
    const match = entryPattern.exec(part);
    if (!match) return null;
    const owner: Owner = match[1] === "cb" ? "cb" : "rails";
    const since = Number(match[2]);
    const previous = entries.at(-1);
    if (previous === undefined) {
      if (since !== 0) return null;
    } else if (since <= previous.since || owner === previous.owner) {
      return null;
    }
    entries.push({ owner, since });
  }
  return entries;
}

export function serializeTimeline(timeline: OwnerTimeline): string {
  return timeline.map((entry) => `${entry.owner}@${entry.since}`).join(";");
}

export function sameTimeline(a: OwnerTimeline, b: OwnerTimeline): boolean {
  return serializeTimeline(a) === serializeTimeline(b);
}

/** Read the marker from Stripe customer metadata, which is untyped at this boundary. */
export function readOwnerMarker(metadata: unknown): OwnerMarker {
  const absent: OwnerMarker = {
    timeline: RAILS_FROM_START,
    generation: 0,
    source: "absent",
    mirrorMismatch: false,
  };
  if (typeof metadata !== "object" || metadata === null) return absent;

  const rawOwner = readStringField(metadata, OWNER_METADATA_KEY);
  const rawTimeline = readStringField(metadata, OWNER_TIMELINE_METADATA_KEY);
  const rawGeneration = readStringField(metadata, OWNER_GENERATION_METADATA_KEY);
  const generation =
    rawGeneration !== undefined && generationPattern.test(rawGeneration)
      ? Number(rawGeneration)
      : 0;

  if (rawTimeline === undefined || rawTimeline === "") {
    if (rawOwner === undefined || rawOwner === "") return { ...absent, generation };
    // An owner without a timeline is a hand edit or a foreign writer: route to Rails.
    return { ...absent, generation, source: "unrecognized" };
  }

  const timeline = parseTimeline(rawTimeline);
  if (timeline === null) return { ...absent, generation, source: "unrecognized" };
  return {
    timeline,
    generation,
    source: "explicit",
    mirrorMismatch: rawOwner !== finalOwner(timeline),
  };
}

/** Owner of an event created at `created` (Stripe event `created`, epoch seconds). */
export function ownerAt(timeline: OwnerTimeline, created: number): Owner {
  let owner: Owner = "rails";
  for (const entry of timeline) {
    if (entry.since <= created) owner = entry.owner;
  }
  return owner;
}

/** Owner once every scheduled flip has taken effect. */
export function finalOwner(timeline: OwnerTimeline): Owner {
  return timeline.at(-1)?.owner ?? "rails";
}

/**
 * Drop entries no event can still need. Stripe retries a delivery for up to three
 * days, so `retentionSeconds` must exceed that. The new first entry starts at 0.
 */
export function compactTimeline(
  timeline: OwnerTimeline,
  now: number,
  retentionSeconds: number,
): OwnerTimeline {
  let entries = [...timeline];
  for (;;) {
    const next = entries[1];
    if (next === undefined || next.since > now - retentionSeconds) break;
    entries = entries.slice(1);
  }
  const first = entries[0];
  if (first === undefined) return RAILS_FROM_START;
  return [{ owner: first.owner, since: 0 }, ...entries.slice(1)];
}

export type AppendFlipResult =
  | { readonly ok: true; readonly timeline: OwnerTimeline }
  | {
      readonly ok: false;
      readonly reason: "already_final_owner" | "flip_not_after_last" | "timeline_full";
    };

export function appendFlip(
  timeline: OwnerTimeline,
  owner: Owner,
  flipAt: number,
  now: number,
  retentionSeconds: number,
): AppendFlipResult {
  const compacted = compactTimeline(timeline, now, retentionSeconds);
  const last = compacted.at(-1);
  if (last !== undefined && last.owner === owner)
    return { ok: false, reason: "already_final_owner" };
  if (last !== undefined && flipAt <= last.since)
    return { ok: false, reason: "flip_not_after_last" };
  if (compacted.length >= MAX_TIMELINE_ENTRIES) return { ok: false, reason: "timeline_full" };
  return { ok: true, timeline: [...compacted, { owner, since: flipAt }] };
}

/** Metadata patch for a marker write. Stripe metadata values are strings. */
export function ownerMarkerMetadata(
  timeline: OwnerTimeline,
  generation: number,
): Record<string, string> {
  return {
    [OWNER_METADATA_KEY]: finalOwner(timeline),
    [OWNER_TIMELINE_METADATA_KEY]: serializeTimeline(timeline),
    [OWNER_GENERATION_METADATA_KEY]: String(generation),
  };
}

/** Metadata for a Stripe customer CB creates. It is CB-owned from its first event. */
export function cbBornCustomerMetadata(): Record<string, string> {
  return ownerMarkerMetadata(CB_FROM_START, 1);
}

/**
 * Stripe idempotency key for one marker write attempt. Stripe caches a 5xx response
 * under its key, so a retry after a 5xx needs a new nonce. A retry after a transport
 * timeout reuses the key, so Stripe returns the first request's result if it ran.
 */
export function ownerMarkerIdempotencyKey(
  customerId: string,
  generation: number,
  nonce: number,
): string {
  return `egghead-owner:${customerId}:${generation}:${nonce}`;
}

/**
 * Events with no Stripe customer (guest one-time payments) route by the checkout
 * session that created them: `egghead_owner == "cb"` on the session means CB.
 */
export function oneTimePaymentOwner(checkoutSessionMetadata: unknown): Owner {
  if (typeof checkoutSessionMetadata !== "object" || checkoutSessionMetadata === null)
    return "rails";
  return readStringField(checkoutSessionMetadata, OWNER_METADATA_KEY) === "cb" ? "cb" : "rails";
}
