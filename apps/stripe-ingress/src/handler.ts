export const SHADOW_PATH = "/api/stripe/subscription-shadow";
export const BODY_LIMIT = 256 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;
const TOLERANCE_SECONDS = 300;

export interface IngressBindings {
  readonly SHADOW_UPSTREAM_URL: string;
  readonly STRIPE_WEBHOOK_SECRET: string;
  readonly VERCEL_PROTECTION_BYPASS: string;
}

type Forward = (url: string, init: RequestInit) => Promise<Response>;

const reply = (status: number) =>
  new Response(status === 204 || status === 205 || status === 304 ? null : "stripe ingress", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

// Compare every byte, including when Stripe sends several rotation signatures.
const equalDigest = (digest: Uint8Array, candidate: string): boolean => {
  if (!/^[a-fA-F0-9]{64}$/.test(candidate)) return false;
  let difference = 0;
  for (let index = 0; index < digest.length; index++) {
    difference |=
      (digest[index] ?? 0) ^ Number.parseInt(candidate.slice(index * 2, index * 2 + 2), 16);
  }
  return difference === 0;
};

async function signed(body: ArrayBuffer, header: string, secret: string, now: number) {
  const parts = header.split(",").map((part) => part.trim());
  const timestamps = parts.filter((part) => part.startsWith("t="));
  const timestamp = timestamps[0]?.slice(2);
  if (timestamps.length !== 1 || timestamp === undefined || !/^\d+$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(now / 1000 - seconds) > TOLERANCE_SECONDS)
    return false;
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const message = new Uint8Array(prefix.length + body.byteLength);
  message.set(prefix);
  message.set(new Uint8Array(body), prefix.length);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  let matched = 0;
  for (const part of parts) {
    if (part.startsWith("v1=")) matched |= Number(equalDigest(digest, part.slice(3)));
  }
  return matched !== 0;
}

async function readBody(request: Request): Promise<ArrayBuffer | undefined> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) return undefined;
  if (request.body === null) return new ArrayBuffer(0);
  // Bound memory as well as bytes, even with a large number of tiny chunks.
  const bytes = new Uint8Array(BODY_LIMIT);
  let size = 0;
  for await (const chunk of request.body) {
    if (size + chunk.byteLength > BODY_LIMIT) return undefined;
    bytes.set(chunk, size);
    size += chunk.byteLength;
  }
  return bytes.buffer.slice(0, size);
}

// Request lifecycle: route -> bounded read -> verify -> one bounded forward -> fixed reply.
// No persistence, background work, retries, customer reads or commerce writes.
export async function handleIngress(
  request: Request,
  bindings: IngressBindings,
  forward: Forward = fetch,
  now: number = Date.now(),
): Promise<Response> {
  if (new URL(request.url).pathname !== SHADOW_PATH) return reply(404);
  if (request.method !== "POST") return reply(405);
  const signature = request.headers.get("stripe-signature");
  if (!signature) return reply(400);
  if (!bindings.STRIPE_WEBHOOK_SECRET || !bindings.VERCEL_PROTECTION_BYPASS) return reply(503);
  try {
    const upstream = new URL(bindings.SHADOW_UPSTREAM_URL);
    if (
      upstream.protocol !== "https:" ||
      upstream.pathname !== SHADOW_PATH ||
      upstream.username ||
      upstream.password ||
      upstream.search ||
      upstream.hash
    )
      return reply(503);
    const body = await readBody(request);
    if (body === undefined) return reply(413);
    if (!(await signed(body, signature, bindings.STRIPE_WEBHOOK_SECRET, now))) return reply(400);
    const response = await forward(upstream.href, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
        "x-vercel-protection-bypass": bindings.VERCEL_PROTECTION_BYPASS,
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // Never consume or expose the upstream body, including errors.
    void response.body?.cancel().catch(() => undefined);
    if (response.status >= 300 && response.status < 400) return reply(502);
    return reply(response.status);
  } catch {
    // No exception logging: upstream errors may contain request details.
    return reply(502);
  }
}
