import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CouponSnapshot } from "@egghead/workshops/contracts";
import { WorkshopFields as Fields } from "./fields";

const Eligibility = Schema.Struct({
  type: Schema.Literal("hasValidProductPurchase"),
  productId: Schema.NonEmptyString,
});

export type CouponData = {
  productId: string;
  couponFields: unknown;
  default: boolean | number;
  expires: Date | string | null;
  percentageDiscount: number | string | null;
  amountDiscount: number | string | null;
  merchantPercentageDiscount: number | string | null;
  merchantAmountDiscount: number | string | null;
};

function isoDate(value: Date | string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function numberValue(value: number | string | null) {
  return value === null ? null : Number(value);
}
export function decodeCouponRow(row: CouponData) {
  const parsed = Schema.decodeUnknownOption(Fields)(row.couponFields);
  const fields = Option.getOrNull(parsed);
  const eligibility = fields
    ? Schema.decodeUnknownOption(Eligibility)(fields["eligibilityCondition"])
    : Option.none();
  const condition = Option.getOrNull(eligibility);
  const audience = condition
    ? { type: "product-purchase", productId: condition.productId }
    : fields && !Object.hasOwn(fields, "eligibilityCondition")
      ? { type: "public" }
      : { type: "unsupported" };
  return Option.getOrNull(
    Schema.decodeUnknownOption(CouponSnapshot)({
      audience,
      isDefault: Boolean(row.default),
      expiresAt: row.expires ? (isoDate(row.expires) ?? "invalid") : null,
      percentage: numberValue(row.merchantPercentageDiscount ?? row.percentageDiscount),
      amount:
        row.merchantAmountDiscount === null && row.amountDiscount === null
          ? null
          : Number(row.merchantAmountDiscount ?? row.amountDiscount) / 100,
    }),
  );
}
