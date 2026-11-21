import { createHmac, timingSafeEqual } from "node:crypto";
import { shadowEventSchema, projectShadowEvent, type ShadowRecord } from "./projection";
import { recordShadowOnce, type ShadowStore } from "./store";
import type { ShadowStripeReader } from "./stripe-reader";
import type { TenantCatalogue } from "./tenant";

/** Stripe v1 signed-payload verification with replay tolerance and secret rotation signatures. */
export function verifyShadowSignature(
  body: string,
  signature: string,
  secret: string,
  now: number,
) {
  const fields = signature.split(",").map((part) => part.split("="));
  const timestamp = fields.find(([key]) => key === "t")?.[1];
  if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 300)
    return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  return fields.some(([key, value]) => {
    if (key !== "v1" || !value || !/^[0-9a-f]{64}$/i.test(value)) return false;
    return timingSafeEqual(expected, Buffer.from(value, "hex"));
  });
}

export interface ShadowDependencies {
  store: ShadowStore;
  stripe: ShadowStripeReader;
  catalogue?: TenantCatalogue;
  log: (record: ShadowRecord) => void;
}

export async function dispatchShadowEvent(
  raw: unknown,
  deps: ShadowDependencies,
  now = Date.now(),
) {
  const event = shadowEventSchema.safeParse(raw);
  if (!event.success) return { status: "ignored" as const };
  return recordShadowOnce(
    event.data.id,
    deps.store,
    () => projectShadowEvent(event.data, deps.stripe, now, deps.catalogue),
    deps.log,
  );
}

/** `configure` is deliberately lazy: unauthenticated requests cannot touch any client. */
export async function handleShadowRequest(
  request: Request,
  secret: string | undefined,
  configure: () => ShadowDependencies,
  now = Date.now(),
): Promise<Response> {
  if (!secret)
    return Response.json({ received: false, error: "shadow-not-configured" }, { status: 503 });
  const signature = request.headers.get("stripe-signature");
  if (!signature) return Response.json({ received: false }, { status: 400 });
  const body = await request.text();
  if (!verifyShadowSignature(body, signature, secret, Math.floor(now / 1000)))
    return Response.json({ received: false }, { status: 400 });
  let verified: unknown;
  try {
    verified = JSON.parse(body);
  } catch {
    return Response.json({ received: false }, { status: 400 });
  }
  try {
    const result = await dispatchShadowEvent(verified, configure(), now);
    return Response.json({ received: true, status: result.status });
  } catch {
    // Never log raw Stripe payloads, transport errors, tokens or customer metadata.
    console.error(
      JSON.stringify({ name: "subscription.shadow.error", reason: "processing-failed", count: 1 }),
    );
    return Response.json({ received: false }, { status: 503 });
  }
}
