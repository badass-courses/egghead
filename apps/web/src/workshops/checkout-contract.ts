export function canPurchaseWorkshop(
  input: { state: string; hasOffer: boolean; startsAt: string },
  now = Date.now(),
) {
  return input.state === "published" && input.hasOffer && Date.parse(input.startsAt) > now;
}

export function workshopCheckoutIdempotencyKey(workshopId: string, requestId: string) {
  return `workshop-checkout:${workshopId}:${requestId}`;
}

export function localWorkshopPurchasesEnabled(
  env: Record<string, string | undefined> = process.env,
) {
  return env["NODE_ENV"] === "development" && env["EGGHEAD_RUNTIME"] === "local";
}

export function isVerifiedWorkshopPayment(session: {
  mode: string | null;
  payment_status: string;
  livemode: boolean;
  amount_total: number | null;
  metadata: Record<string, string> | null;
}) {
  return (
    session.mode === "payment" &&
    session.payment_status === "paid" &&
    !session.livemode &&
    Boolean(
      session.metadata?.["workshopId"] &&
      session.metadata["productId"] &&
      session.metadata["priceId"],
    ) &&
    typeof session.amount_total === "number" &&
    session.amount_total > 0 &&
    /^\d+$/.test(session.metadata?.["expectedTotalCents"] ?? "") &&
    session.amount_total === Number(session.metadata?.["expectedTotalCents"])
  );
}
