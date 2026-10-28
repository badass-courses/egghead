import * as Schema from "effect/Schema";

const Money = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Instant = Schema.String.check(
  Schema.makeFilter(
    (value: string) => /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)),
  ),
);
const PublicUrl = Schema.String.check(
  Schema.makeFilter(
    (value: string) => URL.canParse(value) && ["http:", "https:"].includes(new URL(value).protocol),
  ),
);
export const WorkshopStatus = Schema.Literals([
  "in-progress",
  "past",
  "schedule-pending",
  "upcoming",
]);
export type WorkshopStatus = typeof WorkshopStatus.Type;

export const CouponAudience = Schema.Union([
  Schema.Struct({ type: Schema.Literal("public") }),
  Schema.Struct({ type: Schema.Literal("product-purchase"), productId: Schema.NonEmptyString }),
  Schema.Struct({ type: Schema.Literal("unsupported") }),
]);
export const CouponSnapshot = Schema.Struct({
  audience: CouponAudience,
  isDefault: Schema.Boolean,
  expiresAt: Schema.NullOr(Instant),
  percentage: Schema.NullOr(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  amount: Schema.NullOr(Money),
});
export type CouponSnapshot = typeof CouponSnapshot.Type;

export const OfferSnapshot = Schema.Struct({
  fullPrice: Money,
  productId: Schema.NonEmptyString,
  productName: Schema.String,
  seatsRemaining: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  coupons: Schema.Array(CouponSnapshot),
});
export type OfferSnapshot = typeof OfferSnapshot.Type;
export const WorkshopSnapshot = Schema.Struct({
  id: Schema.NonEmptyString,
  slug: Schema.NonEmptyString,
  title: Schema.String,
  description: Schema.String,
  body: Schema.NullOr(Schema.String),
  imageUrl: Schema.NullOr(PublicUrl),
  registrationUrl: Schema.NullOr(PublicUrl),
  ctaLabel: Schema.NonEmptyString,
  timezone: Schema.NonEmptyString,
  startsAt: Schema.NullOr(Instant),
  endsAt: Schema.NullOr(Instant),
  updatedAt: Instant,
  visibility: Schema.Literals(["public", "unlisted"]),
  offer: Schema.NullOr(OfferSnapshot),
});
export type WorkshopSnapshot = typeof WorkshopSnapshot.Type;

export const RegistrationState = Schema.Union([
  Schema.Struct({ type: Schema.Literal("open"), href: PublicUrl, label: Schema.NonEmptyString }),
  Schema.Struct({ type: Schema.Literal("sold-out") }),
  Schema.Struct({ type: Schema.Literal("closed") }),
  Schema.Struct({ type: Schema.Literal("pending") }),
]);
export type RegistrationState = typeof RegistrationState.Type;
export const WorkshopOffer = Schema.Struct({
  currentPrice: Money,
  fullPrice: Money,
  productId: Schema.NonEmptyString,
  productName: Schema.String,
  discountEndsAt: Schema.NullOr(Instant),
  discountPercent: Schema.NullOr(Schema.Finite),
  conditionalOffer: Schema.NullOr(
    Schema.Struct({ price: Money, requiresProductId: Schema.NonEmptyString }),
  ),
  seatsRemaining: Schema.NullOr(Schema.Int),
  soldOut: Schema.Boolean,
});
export type WorkshopOffer = typeof WorkshopOffer.Type;
export const Workshop = Schema.Struct({
  ...WorkshopSnapshot.fields,
  offer: Schema.NullOr(WorkshopOffer),
  status: WorkshopStatus,
  registration: RegistrationState,
});
export type Workshop = typeof Workshop.Type;

export const WorkshopReference = Schema.Struct({
  id: Schema.NonEmptyString,
  slug: Schema.NonEmptyString,
  updatedAt: Instant,
});
export type WorkshopReference = typeof WorkshopReference.Type;
export const WorkshopCursor = Schema.Struct({ startsAt: Instant, id: Schema.NonEmptyString });
export type WorkshopCursor = typeof WorkshopCursor.Type;
export const GetWorkshopInput = Schema.Struct({ slug: Schema.NonEmptyString });
export const WorkshopPageLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }));
export type GetWorkshopInput = typeof GetWorkshopInput.Type;
export const ListUpcomingInput = Schema.Struct({
  limit: Schema.optional(WorkshopPageLimit),
  after: Schema.optional(WorkshopCursor),
});
export type ListUpcomingInput = typeof ListUpcomingInput.Type;
export const WorkshopPage = Schema.Struct({
  workshops: Schema.Array(Workshop),
  next: Schema.NullOr(WorkshopCursor),
});

export class CatalogUnavailable extends Schema.TaggedError<CatalogUnavailable>()(
  "CatalogUnavailable",
  { operation: Schema.String },
) {}
export class InvalidWorkshopData extends Schema.TaggedError<InvalidWorkshopData>()(
  "InvalidWorkshopData",
  { operation: Schema.String },
) {}
export class InvalidWorkshopInput extends Schema.TaggedError<InvalidWorkshopInput>()(
  "InvalidWorkshopInput",
  { capability: Schema.String },
) {}
const failure = Schema.Union([CatalogUnavailable, InvalidWorkshopData, InvalidWorkshopInput]);
export const getWorkshopContract = {
  name: "getWorkshop",
  description: "Read a published workshop by slug.",
  input: GetWorkshopInput,
  output: Schema.NullOr(Workshop),
  failure,
  annotations: { readOnly: true, idempotent: true },
  needsApproval: false,
} as const;
export const listUpcomingWorkshopsContract = {
  name: "listUpcomingWorkshops",
  description: "List a page of discoverable upcoming or live workshops.",
  input: ListUpcomingInput,
  output: WorkshopPage,
  failure,
  annotations: { readOnly: true, idempotent: true },
  needsApproval: false,
} as const;
