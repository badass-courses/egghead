import type {
  CouponSnapshot,
  OfferSnapshot,
  RegistrationState,
  Workshop,
  WorkshopOffer,
  WorkshopSnapshot,
  WorkshopStatus,
} from "./contracts";

export function workshopFullPrice(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function workshopStatus(
  startsAt: string | null,
  endsAt: string | null,
  now: Date,
): WorkshopStatus {
  const starts = startsAt ? new Date(startsAt) : null;
  const ends = endsAt ? new Date(endsAt) : null;
  if (!starts || Number.isNaN(starts.getTime())) return "schedule-pending";
  const effectiveEnd = ends && !Number.isNaN(ends.getTime()) ? ends : starts;
  if (effectiveEnd <= now) return "past";
  return starts <= now ? "in-progress" : "upcoming";
}

function discountedPrice(fullPrice: number, coupon: CouponSnapshot) {
  const discount =
    coupon.percentage && coupon.percentage > 0
      ? fullPrice * coupon.percentage
      : (coupon.amount ?? 0);
  return Math.round(Math.max(0, fullPrice - discount) * 100) / 100;
}

export function evaluateOffer(snapshot: OfferSnapshot, now: Date): WorkshopOffer {
  const coupons = snapshot.coupons.filter(
    (coupon) => !coupon.expiresAt || new Date(coupon.expiresAt) > now,
  );
  const publicCoupon = coupons.find(
    (coupon) => coupon.isDefault && coupon.audience.type === "public",
  );
  const conditionalCoupon = coupons.find((coupon) => coupon.audience.type === "product-purchase");
  return {
    fullPrice: snapshot.fullPrice,
    productId: snapshot.productId,
    productName: snapshot.productName,
    currentPrice: publicCoupon
      ? discountedPrice(snapshot.fullPrice, publicCoupon)
      : snapshot.fullPrice,
    discountEndsAt: publicCoupon?.expiresAt ?? null,
    discountPercent: publicCoupon?.percentage ? Math.round(publicCoupon.percentage * 100) : null,
    conditionalOffer:
      conditionalCoupon?.audience.type === "product-purchase"
        ? {
            price: discountedPrice(snapshot.fullPrice, conditionalCoupon),
            requiresProductId: conditionalCoupon.audience.productId,
          }
        : null,
    seatsRemaining: snapshot.seatsRemaining,
    soldOut: snapshot.seatsRemaining === 0,
  };
}

export function registrationState(
  status: WorkshopStatus,
  offer: WorkshopOffer | null,
  href: string | null,
  label: string,
): RegistrationState {
  if (offer?.soldOut) return { type: "sold-out" };
  if (status === "past" || status === "in-progress") return { type: "closed" };
  if (status !== "upcoming" || !href) return { type: "pending" };
  return { type: "open", href, label };
}

export function evaluateWorkshop(snapshot: WorkshopSnapshot, now: Date): Workshop {
  const status = workshopStatus(snapshot.startsAt, snapshot.endsAt, now);
  const offer = snapshot.offer ? evaluateOffer(snapshot.offer, now) : null;
  return {
    ...snapshot,
    status,
    offer,
    registration: registrationState(status, offer, snapshot.registrationUrl, snapshot.ctaLabel),
  };
}
