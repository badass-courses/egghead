import { assert, describe, it } from "@effect/vitest";
import { decodeCouponRow, type CouponData } from "../src/coupon";

const row: CouponData = {
  productId: "synthetic-product",
  couponFields: {},
  default: true,
  expires: null,
  percentageDiscount: "0.2",
  amountDiscount: null,
  merchantPercentageDiscount: null,
  merchantAmountDiscount: null,
};

describe("CourseBuilder coupon boundary", () => {
  it("malformed eligibility cannot become a public discount", () => {
    for (const condition of [{}, null, { type: "hasValidProductPurchase" }, { type: "unknown" }]) {
      assert.deepStrictEqual(
        decodeCouponRow({ ...row, couponFields: { eligibilityCondition: condition } })?.audience,
        { type: "unsupported" },
      );
    }
  });
  it("decodes JSON eligibility and preserves its qualifying product", () => {
    assert.deepStrictEqual(
      decodeCouponRow({
        ...row,
        couponFields: JSON.stringify({
          eligibilityCondition: { type: "hasValidProductPurchase", productId: "another-product" },
        }),
      })?.audience,
      { type: "product-purchase", productId: "another-product" },
    );
  });
  it("malformed JSON never becomes an unrestricted discount", () => {
    assert.deepStrictEqual(decodeCouponRow({ ...row, couponFields: "bad-json" })?.audience, {
      type: "unsupported",
    });
  });
  it("invalid discount values and expiry dates cannot advertise an offer", () => {
    assert.strictEqual(decodeCouponRow({ ...row, percentageDiscount: "2" }), null);
    assert.strictEqual(decodeCouponRow({ ...row, percentageDiscount: "-0.2" }), null);
    assert.strictEqual(decodeCouponRow({ ...row, expires: "bad-date" }), null);
  });
  it("converts CourseBuilder fixed discounts from cents to dollars", () => {
    assert.strictEqual(
      decodeCouponRow({ ...row, percentageDiscount: null, merchantAmountDiscount: 2500 })?.amount,
      25,
    );
  });
});
