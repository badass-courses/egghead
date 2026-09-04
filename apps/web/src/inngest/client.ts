import type { CourseBuilderCoreEvents } from "@coursebuilder/core/inngest";
import { EventSchemas, Inngest } from "inngest";

export const STRIPE_CUSTOMER_SUBSCRIPTION_DELETED_EVENT = "stripe/customer-subscription-deleted";
export const STRIPE_INVOICE_PAID_EVENT = "stripe/invoice-paid";

type EggheadEvents = CourseBuilderCoreEvents & {
  [STRIPE_CUSTOMER_SUBSCRIPTION_DELETED_EVENT]: {
    data: {
      stripeEvent: {
        id: string;
        created: number;
        type: "customer.subscription.deleted";
        data: { object: { id: string } };
      };
    };
  };
  [STRIPE_INVOICE_PAID_EVENT]: {
    data: {
      stripeEvent: {
        id: string;
        created: number;
        type: "invoice.paid";
        data: { object: { id: string; subscription: string } };
      };
    };
  };
};

export const inngest = new Inngest({
  id: "egghead-web",
  schemas: new EventSchemas().fromRecord<EggheadEvents>(),
});
