import { eq } from "drizzle-orm";
import { z } from "zod";

import { getEggheadDatabase } from "../db/adapter";
import { assertCommerceWritesAllowed } from "../db/local-docker";
import { organization } from "../db/schema";
import type { CheckoutReservationStore } from "./checkout-state";

const RESERVATION_FIELD = "stripeSubscriptionCheckout";
const fieldsSchema = z.record(z.string(), z.unknown());

export function organizationCheckoutStore(organizationId: string): CheckoutReservationStore {
  return {
    async locked(operation) {
      assertCommerceWritesAllowed();
      return getEggheadDatabase().transaction(async (transaction) => {
        const [row] = await transaction
          .select({ fields: organization.fields })
          .from(organization)
          .where(eq(organization.id, organizationId))
          .for("update");
        if (!row) throw new Error("Checkout organization is missing.");
        const fields = fieldsSchema.parse(row.fields ?? {});
        return operation(fields[RESERVATION_FIELD], async (reservation) => {
          await transaction
            .update(organization)
            .set({
              fields: { ...fields, [RESERVATION_FIELD]: reservation },
            })
            .where(eq(organization.id, organizationId));
        });
      });
    },
  };
}
