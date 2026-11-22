import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Unowned } from "alchemy/AdoptPolicy";
import {
  cloudflareApi,
  CloudflareApiError,
  SECRET_NAMES,
  WORKER_NAME,
  type DeployConfig,
  type WorkerProps,
} from "../infra/cloudflare-api.js";
import { ingressLifecycle } from "../infra/provider.js";

const config: DeployConfig = {
  accountId: "a".repeat(32),
  forwardUrl: "http://127.0.0.1:8789",
  forwardNonce: "synthetic-forward-nonce-0000000000000",
};
const prefix = `/client/v4/accounts/${config.accountId}/workers`;
const script = `${prefix}/scripts/${WORKER_NAME}`;
const subdomain = `${prefix}/services/${WORKER_NAME}/environments/production/subdomain`;
const props: WorkerProps = {
  upstreamUrl: "https://beta.example.test/api/stripe/subscription-shadow",
  modules: { "worker.js": "export default {};", "handler.js": "export const handler = 1;" },
};
const attrs = {
  accountId: config.accountId,
  scriptName: WORKER_NAME,
  url: `https://${WORKER_NAME}.fleet-test.workers.dev`,
};
const json = (result: unknown) => Response.json({ success: true, result });

await test("lifecycle uses only the named script/service plus account subdomain read", async () => {
  let live = false;
  const calls: string[] = [];
  const uploads: FormData[] = [];
  const api = cloudflareApi(config, async (url, init): Promise<Response> => {
    const target = new URL(url);
    assert.equal(target.origin, config.forwardUrl);
    assert.equal(target.search, "");
    const headers = new Headers(init.headers);
    assert.equal(
      headers.get("authorization"),
      "Bearer {{secret:egghead-stripe-ingress/cloudflare}}",
    );
    assert.equal(headers.get("x-sc-forward-token"), config.forwardNonce);
    assert.equal(init.redirect, "manual");
    const call = `${init.method} ${target.pathname}`;
    calls.push(call);
    switch (call) {
      case `GET ${script}`:
        return new Response(live ? "Worker module" : "not found", { status: live ? 200 : 404 });
      case `PUT ${script}`:
        assert.ok(init.body instanceof FormData);
        uploads.push(init.body);
        live = true;
        return json({ id: WORKER_NAME });
      case `POST ${subdomain}`:
        assert.equal(init.body, JSON.stringify({ enabled: true, previews_enabled: false }));
        return json({ enabled: true, previews_enabled: false });
      case `GET ${prefix}/subdomain`:
        return json({ subdomain: "fleet-test" });
      case `DELETE ${script}`:
        if (!live) return new Response(null, { status: 404 });
        live = false;
        return json(null);
      default:
        throw new Error(`out-of-scope API: ${call}`);
    }
  });
  const lifecycle = ingressLifecycle(config, api);
  // Initial plan, first deployment, re-plan, update, and destroy (including retry).
  assert.equal(await lifecycle.read(undefined), undefined);
  assert.deepEqual(await lifecycle.reconcile(props), attrs);
  assert.deepEqual(await lifecycle.read(attrs), attrs);
  assert.deepEqual(await lifecycle.reconcile({ ...props, upstreamUrl: props.upstreamUrl }), attrs);
  // A live name without a local receipt must never be silently adopted.
  assert.ok(Unowned.is(await lifecycle.read(undefined)));
  await lifecycle.remove(attrs);
  await lifecycle.remove(attrs);
  assert.equal(await lifecycle.read(attrs), undefined);
  assert.equal(uploads.length, 2);
  await Promise.all(
    uploads.map(async (upload) => {
      const raw = upload.get("metadata");
      assert.equal(typeof raw, "string");
      assert.ok(typeof raw === "string");
      const metadata: unknown = JSON.parse(raw);
      assert.deepEqual(metadata, {
        main_module: "worker.js",
        compatibility_date: "2026-11-21",
        bindings: [{ type: "plain_text", name: "SHADOW_UPSTREAM_URL", text: props.upstreamUrl }],
        keep_bindings: ["secret_text"],
        logpush: false,
        observability: {
          enabled: false,
          logs: { enabled: false, invocation_logs: false },
          traces: { enabled: false },
        },
        tail_consumers: [],
        streaming_tail_consumers: [],
      });
      assert.deepEqual([...upload.keys()].toSorted(), ["handler.js", "metadata", "worker.js"]);
      const workerModule = upload.get("worker.js");
      assert.ok(workerModule instanceof Blob);
      assert.equal(await workerModule.text(), props.modules["worker.js"]);
      assert.equal(raw.includes(config.forwardNonce), false);
      assert.equal(raw.includes("{{secret:"), false);
    }),
  );
  assert.equal(
    calls.some((call) =>
      /\/zones|\/domains|\/settings|\/accounts$|\/scripts$|\/tails|\/telemetry/.test(call),
    ),
    false,
  );
  assert.deepEqual(SECRET_NAMES, ["STRIPE_WEBHOOK_SECRET", "VERCEL_PROTECTION_BYPASS"]);
});

await test("account/state mismatches refuse before HTTP; profiles and direct URLs are not accepted", async () => {
  let calls = 0;
  const api = cloudflareApi(config, async () => {
    calls++;
    assert.fail("must not call");
  });
  const lifecycle = ingressLifecycle(config, api);
  const foreign = { ...attrs, accountId: "b".repeat(32) };
  await assert.rejects(lifecycle.read(foreign), CloudflareApiError);
  await assert.rejects(lifecycle.remove(foreign), CloudflareApiError);
  assert.equal(calls, 0);
  for (const forwardUrl of [
    "https://api.cloudflare.com",
    "http://localhost:8789",
    "http://0.0.0.0:8789",
    "http://127.0.0.1:8789/path",
    "http://127.0.0.1:8789/?token=bad",
  ]) {
    assert.throws(() => cloudflareApi({ ...config, forwardUrl }));
  }
  assert.throws(() => cloudflareApi({ ...config, accountId: "../other" }));
  assert.throws(() => cloudflareApi({ ...config, forwardNonce: "" }));
});

await test("API failures, redirects and malformed responses fail closed without leaking bodies or retrying", async () => {
  await Promise.all(
    [302, 403, 429, 500].map(async (status) => {
      let calls = 0;
      const api = cloudflareApi(config, async () => {
        calls++;
        return new Response("private-upstream-detail", { status });
      });
      await assert.rejects(
        api.upload(props),
        (error: unknown) =>
          error instanceof CloudflareApiError && !error.message.includes("private-upstream-detail"),
      );
      assert.equal(calls, 1);
    }),
  );
  const broken = cloudflareApi(config, async () => {
    throw new Error("private-transport-detail");
  });
  await assert.rejects(
    broken.exists(),
    (error: unknown) =>
      error instanceof CloudflareApiError && !error.message.includes("private-transport-detail"),
  );
  const malformed = cloudflareApi(config, async () => json({ subdomain: "evil.example/path" }));
  await assert.rejects(malformed.attributes(), CloudflareApiError);
});

await test("Worker runtime does not log headers, bodies or errors", async () => {
  const sources = await Promise.all(
    ["handler", "worker"].map((name) =>
      readFile(new URL(`../src/${name}.ts`, import.meta.url), "utf8"),
    ),
  );
  for (const source of sources) assert.equal(/console\.|\.log\(/.test(source), false);
});
