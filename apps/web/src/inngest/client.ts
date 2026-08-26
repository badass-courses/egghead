import type { CourseBuilderCoreEvents } from "@coursebuilder/core/inngest";
import { EventSchemas, Inngest } from "inngest";

export const inngest = new Inngest({
  id: "egghead-web",
  schemas: new EventSchemas().fromRecord<CourseBuilderCoreEvents>(),
});
