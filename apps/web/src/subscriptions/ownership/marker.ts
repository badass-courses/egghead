// The ownership marker lives on the Stripe subscription (and on CB-created checkout
// sessions) as metadata. Both Rails and CourseBuilder read the same two keys, so the
// marker is the single fact that decides who acts on a Stripe event.
//
// Rails compares `metadata["egghead_owner"] == "cb"` exactly. CourseBuilder must read
// it the same way: any other value, including a missing key or a typo, means Rails.
// Diverging here would let both sides act, or neither.

export const OWNER_METADATA_KEY = "egghead_owner";
export const OWNER_GENERATION_METADATA_KEY = "egghead_owner_generation";

export type Owner = "rails" | "cb";

export type OwnerMarkerSource = "explicit" | "absent" | "unrecognized";

export interface OwnerMarker {
  readonly owner: Owner;
  /** Monotonic write counter. 0 when the key is missing or not a non-negative integer. */
  readonly generation: number;
  /** How the owner was derived; `unrecognized` should raise an alert, never a refusal. */
  readonly source: OwnerMarkerSource;
}

const generationPattern = /^\d{1,15}$/;

function readStringField(metadata: object, key: string): string | undefined {
  const value: unknown = Reflect.get(metadata, key);
  return typeof value === "string" ? value : undefined;
}

/** Read the marker from Stripe metadata, which is untyped JSON at this boundary. */
export function readOwnerMarker(metadata: unknown): OwnerMarker {
  if (typeof metadata !== "object" || metadata === null) {
    return { owner: "rails", generation: 0, source: "absent" };
  }

  const rawOwner = readStringField(metadata, OWNER_METADATA_KEY);
  const rawGeneration = readStringField(metadata, OWNER_GENERATION_METADATA_KEY);
  const generation =
    rawGeneration !== undefined && generationPattern.test(rawGeneration)
      ? Number(rawGeneration)
      : 0;

  if (rawOwner === undefined || rawOwner === "") {
    return { owner: "rails", generation, source: "absent" };
  }
  if (rawOwner === "cb") return { owner: "cb", generation, source: "explicit" };
  if (rawOwner === "rails") return { owner: "rails", generation, source: "explicit" };
  return { owner: "rails", generation, source: "unrecognized" };
}

/** Metadata patch for a marker write. Stripe metadata values are strings. */
export function ownerMarkerMetadata(owner: Owner, generation: number): Record<string, string> {
  return {
    [OWNER_METADATA_KEY]: owner,
    [OWNER_GENERATION_METADATA_KEY]: String(generation),
  };
}

/** Stripe idempotency key for one marker write. Retrying the same write reuses it. */
export function ownerMarkerIdempotencyKey(
  subscriptionId: string,
  owner: Owner,
  generation: number,
): string {
  return `egghead-owner:${subscriptionId}:${owner}:${generation}`;
}

/**
 * One-time payments (workshops, the first canary) have no subscription to hand over.
 * The checkout session that created the payment carries the marker, and that session's
 * creator owns its events for life.
 */
export function oneTimePaymentOwner(checkoutSessionMetadata: unknown): Owner {
  return readOwnerMarker(checkoutSessionMetadata).owner;
}
