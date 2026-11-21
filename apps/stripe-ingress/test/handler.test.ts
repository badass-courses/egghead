import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { BODY_LIMIT, FETCH_TIMEOUT_MS, handleIngress, SHADOW_PATH } from "../src/handler.js";

const now = 1_800_000_000_000;
const secret = "synthetic-webhook-secret";
const bindings = {
  SHADOW_UPSTREAM_URL: `https://beta.example.test${SHADOW_PATH}`,
  STRIPE_WEBHOOK_SECRET: secret,
  VERCEL_PROTECTION_BYPASS: "synthetic-bypass",
};
const body = new TextEncoder().encode('{"text":"café 🐀"}\n');
const signature = (payload = body, key = secret, timestamp = now / 1000) =>
  `t=${timestamp},v1=${createHmac("sha256", key).update(`${timestamp}.`).update(payload).digest("hex")}`;
const request = (
  headers: HeadersInit = { "stripe-signature": signature() },
  payload: BodyInit = body,
) =>
  new Request(`https://ingress.example.test${SHADOW_PATH}`, {
    method: "POST",
    headers,
    body: payload,
  });
const forbiddenForward = async () => {
  assert.fail("must not forward");
};

await test("only the exact POST path is exposed; no OPTIONS/CORS", async () => {
  await Promise.all(
    ["/", `${SHADOW_PATH}/`, "/api/other"].map(async (path) => {
      const response = await handleIngress(
        new Request(`https://ingress.example.test${path}`, { method: "POST" }),
        bindings,
        forbiddenForward,
        now,
      );
      assert.equal(response.status, 404);
    }),
  );
  await Promise.all(
    ["GET", "HEAD", "PUT", "OPTIONS"].map(async (method) => {
      const response = await handleIngress(
        new Request(`https://ingress.example.test${SHADOW_PATH}`, { method }),
        bindings,
        forbiddenForward,
        now,
      );
      assert.equal(response.status, 405);
      assert.equal(response.headers.has("access-control-allow-origin"), false);
    }),
  );
});

await test("real signature forwards exact bytes once to fixed upstream with only allowed headers", async () => {
  const headers = new Headers({
    "stripe-signature": signature(),
    "content-type": "text/evil",
    authorization: "client-auth",
    cookie: "client-cookie",
    "x-vercel-protection-bypass": "client-bypass",
    "x-vercel-id": "client-id",
    host: "evil.example.test",
  });
  let calls = 0;
  const incoming = new Request(
    `https://evil.example.test${SHADOW_PATH}?target=https://evil.example.test`,
    { method: "POST", body, headers },
  );
  const response = await handleIngress(
    incoming,
    bindings,
    async (url, init) => {
      calls++;
      assert.equal(url, bindings.SHADOW_UPSTREAM_URL);
      assert.equal(init.redirect, "manual");
      assert.equal(init.method, "POST");
      assert.ok(init.body instanceof ArrayBuffer);
      assert.deepEqual(new Uint8Array(init.body), body);
      assert.deepEqual(
        [...new Headers(init.headers)],
        [
          ["content-type", "application/json"],
          ["stripe-signature", signature()],
          ["x-vercel-protection-bypass", bindings.VERCEL_PROTECTION_BYPASS],
        ],
      );
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(init.signal.aborted, false);
      return new Response("private upstream content", {
        status: 202,
        headers: { "set-cookie": "private", "x-private": "private" },
      });
    },
    now,
  );
  assert.equal(calls, 1);
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "stripe ingress");
  assert.deepEqual([...response.headers], [["content-type", "text/plain; charset=utf-8"]]);
});

await test("missing, wrong-secret, stale, future, tampered and malformed signatures never forward", async () => {
  const cases = [
    request({}),
    request({ "stripe-signature": signature(body, "wrong") }),
    request({ "stripe-signature": signature(body, secret, now / 1000 - 301) }),
    request({ "stripe-signature": signature(body, secret, now / 1000 + 301) }),
    request({ "stripe-signature": signature() }, "tampered"),
    request({ "stripe-signature": `t=${now / 1000},v1=bad` }),
    request({ "stripe-signature": `t=${now / 1000},t=${now / 1000},v1=bad` }),
    request({ "stripe-signature": "t=NaN,v1=bad" }),
  ];
  await Promise.all(
    cases.map(async (input) => {
      assert.equal((await handleIngress(input, bindings, forbiddenForward, now)).status, 400);
    }),
  );
});

await test("multiple v1 signatures and tolerance boundary work", async () => {
  await Promise.all(
    [-300, 300].map(async (offset) => {
      const header = `${signature(body, secret, now / 1000 + offset)},v1=${"0".repeat(64)}`;
      assert.equal(
        (
          await handleIngress(
            request({ "stripe-signature": header }),
            bindings,
            async () => new Response(null, { status: 204 }),
            now,
          )
        ).status,
        204,
      );
    }),
  );
});

await test("declared length and streaming/chunked body are capped", async () => {
  assert.equal(
    (
      await handleIngress(
        request({ "stripe-signature": signature(), "content-length": String(BODY_LIMIT + 1) }),
        bindings,
        forbiddenForward,
        now,
      )
    ).status,
    413,
  );
  const large = new Uint8Array(BODY_LIMIT + 1);
  await Promise.all(
    [undefined, "1"].map(async (length) => {
      const headers = new Headers({ "stripe-signature": signature(large) });
      if (length) headers.set("content-length", length);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(large.subarray(0, BODY_LIMIT));
          controller.enqueue(large.subarray(BODY_LIMIT));
          controller.close();
        },
      });
      // Node's streaming fetch requires duplex; browsers do not declare it in RequestInit.
      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        headers,
        body: stream,
        duplex: "half",
      };
      const input = new Request(`https://ingress.example.test${SHADOW_PATH}`, init);
      assert.equal((await handleIngress(input, bindings, forbiddenForward, now)).status, 413);
    }),
  );
  const exact = new Uint8Array(BODY_LIMIT);
  assert.equal(
    (
      await handleIngress(
        request({ "stripe-signature": signature(exact) }, exact),
        bindings,
        async () => new Response("ok"),
        now,
      )
    ).status,
    200,
  );
});

await test("redirects become retryable errors; upstream statuses have fixed bodies", async () => {
  await Promise.all(
    [301, 302, 307, 308].map(async (status) => {
      assert.equal(
        (
          await handleIngress(
            request(),
            bindings,
            async () =>
              new Response("private", {
                status,
                headers: { location: "https://evil.example.test" },
              }),
            now,
          )
        ).status,
        502,
      );
    }),
  );
  await Promise.all(
    [200, 204, 205, 400, 429, 500, 503].map(async (status) => {
      const response = await handleIngress(
        request(),
        bindings,
        async () => new Response(null, { status }),
        now,
      );
      assert.equal(response.status, status);
      assert.equal(await response.text(), [204, 205].includes(status) ? "" : "stripe ingress");
    }),
  );
});

await test("network failure and bounded timeout return 5xx without retries", async () => {
  let calls = 0;
  assert.equal(
    (
      await handleIngress(
        request(),
        bindings,
        async () => {
          calls++;
          throw new Error("private upstream error");
        },
        now,
      )
    ).status,
    502,
  );
  assert.equal(calls, 1);
  const original = AbortSignal.timeout.bind(AbortSignal);
  const durations: number[] = [];
  AbortSignal.timeout = (milliseconds) => {
    durations.push(milliseconds);
    return AbortSignal.abort();
  };
  try {
    calls = 0;
    const response = await handleIngress(
      request(),
      bindings,
      async (_url, init) => {
        calls++;
        init.signal?.throwIfAborted();
        assert.fail("expected aborted signal");
      },
      now,
    );
    assert.equal(response.status, 502);
    assert.equal(calls, 1);
    assert.deepEqual(durations, [FETCH_TIMEOUT_MS]);
    assert.equal(FETCH_TIMEOUT_MS, 10_000);
  } finally {
    AbortSignal.timeout = original;
  }
});

await test("missing secrets and invalid upstream fail closed", async () => {
  await Promise.all(
    [
      { STRIPE_WEBHOOK_SECRET: "" },
      { VERCEL_PROTECTION_BYPASS: "" },
      { SHADOW_UPSTREAM_URL: "http://beta.example.test/api/stripe/subscription-shadow" },
      { SHADOW_UPSTREAM_URL: `${bindings.SHADOW_UPSTREAM_URL}?bypass=bad` },
      { SHADOW_UPSTREAM_URL: "https://beta.example.test/other" },
    ].map(async (changed) => {
      assert.equal(
        (await handleIngress(request(), { ...bindings, ...changed }, forbiddenForward, now)).status,
        503,
      );
    }),
  );
});
