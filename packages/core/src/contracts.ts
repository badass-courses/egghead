import { Schema } from "effect";
import { defineContract } from "./capability";

const boundedText = (min: number, max: number) =>
  Schema.String.pipe(Schema.minLength(min), Schema.maxLength(max));
const instant = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/),
);
const revision = Schema.Number.pipe(Schema.int(), Schema.positive());

export class WorkshopFailure extends Schema.TaggedError<WorkshopFailure>()("WorkshopFailure", {
  code: Schema.Literal(
    "NotFound",
    "Unauthorized",
    "InvalidWorkshop",
    "Conflict",
    "StoreUnavailable",
    "RuntimeBlocked",
  ),
  message: Schema.String,
}) {}

export const WorkshopFields = Schema.Struct({
  title: boundedText(2, 90),
  slug: boundedText(1, 160),
  description: boundedText(0, 500),
  startsAt: instant,
  endsAt: instant,
  timezone: boundedText(1, 100),
  attendeeInstructions: boundedText(0, 10000),
  state: Schema.Literal("draft"),
  visibility: Schema.Literal("unlisted"),
  workshopRevision: revision,
});

export const Workshop = Schema.Struct({
  id: boundedText(1, 200),
  type: Schema.Literal("workshop"),
  createdById: boundedText(1, 200),
  fields: WorkshopFields,
});
export type Workshop = typeof Workshop.Type;

export const WorkshopChanges = Schema.Struct({
  title: Schema.optionalWith(boundedText(2, 90), { exact: true }),
  description: Schema.optionalWith(boundedText(0, 500), { exact: true }),
  startsAt: Schema.optionalWith(instant, { exact: true }),
  endsAt: Schema.optionalWith(instant, { exact: true }),
  timezone: Schema.optionalWith(boundedText(1, 100), { exact: true }),
  attendeeInstructions: Schema.optionalWith(boundedText(0, 10000), { exact: true }),
});

export const CreateWorkshopInput = Schema.Struct({
  requestId: Schema.UUID,
  title: boundedText(2, 90),
  description: boundedText(0, 500),
  startsAt: instant,
  endsAt: instant,
  timezone: boundedText(1, 100),
  attendeeInstructions: boundedText(0, 10000),
});

const UpdateWorkshopInput = Schema.Struct({
  id: boundedText(1, 200),
  expectedRevision: revision,
  changes: WorkshopChanges,
});

export const WorkshopPage = Schema.Struct({
  workshops: Schema.Array(Workshop),
  nextCursor: Schema.NullOr(Schema.String),
});

const readAnnotations = { readOnly: true, idempotent: true, destructive: false, openWorld: false };
const writeAnnotations = {
  readOnly: false,
  idempotent: false,
  destructive: false,
  openWorld: false,
};
const common = { failure: WorkshopFailure };

export const listWorkshopsContract = defineContract("list_workshops", {
  ...common,
  description: "List native draft Workshops. The nextCursor continues a bounded page.",
  input: Schema.Struct({
    limit: Schema.Number.pipe(Schema.int(), Schema.between(1, 50)),
    cursor: Schema.optional(boundedText(1, 200)),
  }),
  output: WorkshopPage,
  annotations: readAnnotations,
  needsApproval: false,
});

export const getWorkshopContract = defineContract("get_workshop", {
  ...common,
  description: "Inspect a native draft Workshop by ID.",
  input: Schema.Struct({ id: boundedText(1, 200) }),
  output: Workshop,
  annotations: readAnnotations,
  needsApproval: false,
});

export const previewCreateWorkshopContract = defineContract("preview_create_workshop", {
  ...common,
  description: "Preview a draft Workshop without writes. Reuse requestId when confirming.",
  input: CreateWorkshopInput,
  output: Workshop,
  annotations: readAnnotations,
  needsApproval: false,
});

export const createWorkshopContract = defineContract("create_workshop", {
  ...common,
  description:
    "Create a native draft Workshop after explicit approval. Creates no Product, coupon, or calendar event.",
  input: CreateWorkshopInput,
  output: Workshop,
  annotations: writeAnnotations,
  needsApproval: true,
});

export const previewUpdateWorkshopContract = defineContract("preview_update_workshop", {
  ...common,
  description: "Preview edits to a draft Workshop at its expected revision without writes.",
  input: UpdateWorkshopInput,
  output: Workshop,
  annotations: readAnnotations,
  needsApproval: false,
});

export const updateWorkshopContract = defineContract("update_workshop", {
  ...common,
  description:
    "Revise a native draft Workshop after approval; rejects stale revisions and invalid schedules.",
  input: UpdateWorkshopInput,
  output: Workshop,
  annotations: writeAnnotations,
  needsApproval: true,
});
