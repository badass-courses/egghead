import type { CourseBuilderCoreEvents } from "@coursebuilder/core/events";
import { EventSchemas, Inngest } from "inngest";
import type { EggheadSubscriptionEvents } from "../subscriptions/webhook-contract";

export const inngest = new Inngest({
  id: "egghead-web",
  schemas: new EventSchemas().fromRecord<CourseBuilderCoreEvents & EggheadSubscriptionEvents>(),
});
