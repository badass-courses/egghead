import { eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { getEggheadDatabase } from "../db/adapter";
import { merchantCustomer, merchantSubscription, subscription } from "../db/schema";
import {
  OWNER_GENERATION_METADATA_KEY,
  OWNER_METADATA_KEY,
  OWNER_TIMELINE_METADATA_KEY,
} from "./ownership/marker";

// ADR-0001 §14 L2: a deleted Stripe customer has no live metadata, so its events
// route by the timeline its `customer.deleted` payload carried. CourseBuilder keeps
// that marker on the customer's local subscription rows (`Subscription.fields`),
// the only rows it could ever write for that customer; no new table.

/** Where in `Subscription.fields` the deleted customer's marker metadata is kept. */
export const DELETED_CUSTOMER_MARKER_FIELD = "deletedStripeCustomerMarker";

const markerKeys = [
  OWNER_METADATA_KEY,
  OWNER_TIMELINE_METADATA_KEY,
  OWNER_GENERATION_METADATA_KEY,
] as const;
const storedMarkerSchema = z.record(z.string(), z.string());
const fieldsSchema = z.record(z.string(), z.unknown());

/** Only the ownership marker keys of a customer's metadata; nothing else is kept. */
export function deletedCustomerMarker(metadata: unknown): Record<string, string> {
  const parsed = storedMarkerSchema.safeParse(metadata);
  if (!parsed.success) return {};
  return Object.fromEntries(
    markerKeys.flatMap((key) => {
      const value = parsed.data[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

/** The local subscription rows that belong to one Stripe customer. */
const LOCAL_ROW_LIMIT = 100;

type Database = ReturnType<typeof getEggheadDatabase>;

async function customerSubscriptionIds(database: Database, stripeCustomerId: string) {
  const rows = await database
    .select({ id: subscription.id })
    .from(subscription)
    .innerJoin(
      merchantSubscription,
      eq(merchantSubscription.id, subscription.merchantSubscriptionId),
    )
    .innerJoin(merchantCustomer, eq(merchantCustomer.id, merchantSubscription.merchantCustomerId))
    .where(eq(merchantCustomer.identifier, stripeCustomerId))
    .limit(LOCAL_ROW_LIMIT);
  return rows.map((row) => row.id);
}

/**
 * Keep the marker from a `customer.deleted` payload on that customer's local rows.
 * Each row is locked, so a concurrent lifecycle write (which rewrites `fields`
 * from the locked row) keeps it. Returns how many rows were marked.
 */
export async function recordDeletedCustomer(
  input: { stripeCustomerId: string; metadata: unknown },
  database: Database = getEggheadDatabase(),
) {
  const ids = await customerSubscriptionIds(database, input.stripeCustomerId);
  if (ids.length === 0) return 0;
  const marker = deletedCustomerMarker(input.metadata);
  await database.transaction(async (transaction) => {
    const locked = await transaction
      .select({ id: subscription.id, fields: subscription.fields })
      .from(subscription)
      .where(inArray(subscription.id, ids))
      .for("update");
    // One connection: the updates run in order inside the transaction.
    await Promise.all(
      locked.map((row) => {
        const fields = fieldsSchema.safeParse(row.fields ?? {});
        return transaction
          .update(subscription)
          .set({
            fields: {
              ...(fields.success ? fields.data : {}),
              [DELETED_CUSTOMER_MARKER_FIELD]: marker,
            },
          })
          .where(eq(subscription.id, row.id));
      }),
    );
  });
  return ids.length;
}

/**
 * What CourseBuilder knows about a deleted customer:
 * - `no-local-rows`: CB has nothing it could write for this customer;
 * - `pending`: CB has rows but has not seen the `customer.deleted` payload yet;
 * - `recorded`: the payload's marker metadata.
 */
export type DeletedCustomerRecord =
  | { readonly status: "no-local-rows" }
  | { readonly status: "pending" }
  | { readonly status: "recorded"; readonly metadata: Record<string, string> };

export async function readDeletedCustomerRecord(
  stripeCustomerId: string,
  database: Database = getEggheadDatabase(),
): Promise<DeletedCustomerRecord> {
  const ids = await customerSubscriptionIds(database, stripeCustomerId);
  if (ids.length === 0) return { status: "no-local-rows" };
  const rows = await database
    .select({ fields: subscription.fields })
    .from(subscription)
    .where(inArray(subscription.id, ids));
  for (const row of rows) {
    const fields = fieldsSchema.safeParse(row.fields ?? {});
    const marker = storedMarkerSchema.safeParse(
      fields.success ? fields.data[DELETED_CUSTOMER_MARKER_FIELD] : undefined,
    );
    if (marker.success) return { status: "recorded", metadata: marker.data };
  }
  return { status: "pending" };
}
