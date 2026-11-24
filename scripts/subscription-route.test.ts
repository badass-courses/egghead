// Drives the real Stripe webhook route `POST` as it is wired: main's workshop
// bypass and relay, then the deletion seam, then the CourseBuilder handler.
// Only the CourseBuilder handler and the Inngest client are replaced, so the
// test can see which requests reach CourseBuilder and whether anything was sent.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { StripePaymentAdapter } from "@coursebuilder/commerce/stripe-provider";
import { z } from "zod";

const forwarded: Array<{ path: string; body: string }> = [];
const sent: unknown[] = [];
let courseBuilderStatus = 200;
mock.module(new URL("../apps/web/src/coursebuilder/config.ts", import.meta.url).href, {
  namedExports: {
    handlers: {
      GET: async () => new Response("coursebuilder get"),
      POST: async (request: Request) => {
        // CourseBuilder reads the original body; it must still be unread here.
        forwarded.push({ path: new URL(request.url).pathname, body: await request.text() });
        return Response.json({ handledBy: "coursebuilder" }, { status: courseBuilderStatus });
      },
    },
  },
});
mock.module(new URL("../apps/web/src/inngest/client.ts", import.meta.url).href, {
  namedExports: {
    inngest: {
      send: async (event: unknown) => {
        sent.push(event);
        return { ids: ["synthetic"] };
      },
    },
  },
});

// Only the Stripe customer read is replaced: routing runs #47's real marker and
// routing rule against this customer metadata.
let customerMetadata: Record<string, string> = { egghead_owner_timeline: "cb@0" };
const { readOwnerMarker } = await import("../apps/web/src/subscriptions/ownership/marker");
const { routeStripeEvent } = await import("../apps/web/src/subscriptions/ownership/routing");
mock.module(new URL("../apps/web/src/subscriptions/ownership-seam.ts", import.meta.url).href, {
  namedExports: {
    decideEventOwnership: async (input: {
      eventId: string;
      eventCreated: number;
      stripeCustomerId: string | null;
    }) => {
      const decision = routeStripeEvent({
        eventId: input.eventId,
        eventCreated: input.eventCreated,
        subject: { kind: "customer", marker: readOwnerMarker(customerMetadata) },
        receivedAt: 1,
        priorStamp: null,
      });
      assert.equal(decision.scope, "owned");
      if (decision.scope !== "owned") throw new Error("unexpected account-level routing");
      return {
        stamp: decision.stamp,
        eventCreated: input.eventCreated,
        stripeCustomerId: input.stripeCustomerId,
      };
    },
  },
});

const route = await import(
  new URL("../apps/web/src/app/api/coursebuilder/[...nextCourseBuilder]/route.ts", import.meta.url)
    .href
);

const secret = "synthetic-webhook-secret";
const signer = new StripePaymentAdapter({
  stripeToken: "sk_test_synthetic",
  stripeWebhookSecret: secret,
});
const webhookUrl = "https://example.test/api/coursebuilder/webhook/stripe";

function signedEvent(
  type: string,
  object: Record<string, unknown> = { id: "sub_synthetic", customer: "cus_synthetic" },
) {
  const body = JSON.stringify({
    id: `evt_${type}_${String(object["id"])}`,
    created: 100,
    livemode: false,
    type,
    data: { object },
  });
  const signature = signer.stripe.webhooks.generateTestHeaderString({ payload: body, secret });
  return {
    body,
    request: () =>
      new Request(webhookUrl, { method: "POST", body, headers: { "stripe-signature": signature } }),
  };
}

const runtimes = {
  beta: {
    EGGHEAD_RUNTIME: "beta",
    EGGHEAD_BETA_DB_APPROVED: "true",
    DATABASE_URL: "mysql://synthetic:synthetic@aws.connect.psdb.cloud/synthetic",
    NODE_ENV: "production",
  },
  production: {
    EGGHEAD_RUNTIME: "production",
    DATABASE_URL: "mysql://synthetic:synthetic@aws.connect.psdb.cloud/synthetic",
    NODE_ENV: "production",
  },
} as const;
const keys = [
  "EGGHEAD_RUNTIME",
  "EGGHEAD_BETA_DB_APPROVED",
  "DATABASE_URL",
  "NODE_ENV",
  "NEXT_PUBLIC_APP_URL",
  "STRIPE_SECRET_TOKEN",
  "STRIPE_WEBHOOK_SECRET",
];

async function withEnv(values: Record<string, string>, work: () => Promise<void>) {
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, {
      NEXT_PUBLIC_APP_URL: "https://example.test",
      STRIPE_SECRET_TOKEN: "sk_test_synthetic",
      STRIPE_WEBHOOK_SECRET: secret,
      ...values,
    });
    await work();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function runtimeTests(name: string, env: Record<string, string>) {
  await test(`${name}: a signed deletion is acknowledged with 2xx and nothing is written or sent`, async () => {
    await withEnv(env, async () => {
      forwarded.length = 0;
      sent.length = 0;
      const response = await route.POST(signedEvent("customer.subscription.deleted").request());
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { received: true, skipped: "writes-blocked" });
      assert.deepEqual(sent, []);
      assert.deepEqual(forwarded, []);
    });
  });

  await test(`${name}: refunds, disputes, dunning and customer deletions respect ingress policy`, async () => {
    await withEnv(env, async () => {
      forwarded.length = 0;
      sent.length = 0;
      // Production still forwards these to the CourseBuilder adapter. Beta does not
      // delegate to the writer-capable transport at all.
      const events = [
        signedEvent("customer.deleted", {
          id: "cus_synthetic",
          metadata: { egghead_owner: "cb", egghead_owner_timeline: "cb@0" },
        }),
        signedEvent("invoice.payment_failed", { id: "in_synthetic", customer: "cus_synthetic" }),
        // A workshop charge (no invoice) and a subscription charge (an invoice).
        signedEvent("charge.refunded", {
          id: "ch_workshop",
          customer: "cus_synthetic",
          invoice: null,
        }),
        signedEvent("charge.dispute.created", { id: "dp_workshop", charge: "ch_workshop" }),
        signedEvent("charge.refunded", {
          id: "ch_sub",
          customer: "cus_synthetic",
          invoice: "in_sub",
        }),
        signedEvent("charge.dispute.created", { id: "dp_sub", charge: "ch_sub" }),
      ];
      const replies = await Promise.all(events.map((event) => route.POST(event.request())));
      assert.deepEqual(
        await Promise.all(replies.map((reply) => reply.json())),
        events.map(() =>
          name === "beta"
            ? { received: true, skipped: "writes-blocked" }
            : { handledBy: "coursebuilder" },
        ),
      );
      assert.deepEqual(
        forwarded.map((entry) => entry.body).toSorted(),
        name === "beta" ? [] : events.map((event) => event.body).toSorted(),
      );
      assert.deepEqual(sent, []);
    });
  });

  await test(`${name}: checkout, update and workshop events respect ingress policy`, async () => {
    await withEnv(env, async () => {
      forwarded.length = 0;
      sent.length = 0;
      const events = [
        signedEvent("checkout.session.completed", { id: "cs_synthetic", mode: "subscription" }),
        signedEvent("customer.subscription.updated"),
        signedEvent("checkout.session.async_payment_succeeded", {
          id: "cs_workshop",
          metadata: { workshopId: "synthetic-workshop" },
        }),
      ];
      const responses = await Promise.all(events.map((event) => route.POST(event.request())));
      assert.deepEqual(
        responses.map((response) => response.status),
        [200, 200, 200],
      );
      assert.deepEqual(
        forwarded.map((entry) => entry.body).toSorted(),
        name === "beta" ? [] : events.map((event) => event.body).toSorted(),
      );
      assert.deepEqual(sent, []);
      // The beta endpoint is a no-op. Elsewhere CourseBuilder verifies what it receives.
      const forged = new Request(webhookUrl, {
        method: "POST",
        body: events[1]?.body ?? "",
        headers: { "stripe-signature": "t=1,v1=forged" },
      });
      assert.equal((await route.POST(forged)).status, 200);
      assert.equal(forwarded.length, name === "beta" ? 0 : 4);
    });
  });
}

await runtimeTests("beta", runtimes.beta);
await runtimeTests("production", runtimes.production);

await test("local development: the workshop relay reads a clone, so a deletion still reaches the writer", async () => {
  await withEnv(
    {
      EGGHEAD_RUNTIME: "local",
      DATABASE_URL: "mysql://root:root@127.0.0.1:3307/coursebuilder_test",
      NODE_ENV: "development",
    },
    async () => {
      forwarded.length = 0;
      sent.length = 0;
      customerMetadata = { egghead_owner_timeline: "cb@0" };
      const response = await route.POST(signedEvent("customer.subscription.deleted").request());
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { received: true });
      assert.equal(sent.length, 1);
      assert.deepEqual(forwarded, []);
    },
  );
});

await test("local development: a deletion for a Rails-owned customer is acknowledged, never published", async () => {
  await withEnv(
    {
      EGGHEAD_RUNTIME: "local",
      DATABASE_URL: "mysql://root:root@127.0.0.1:3307/coursebuilder_test",
      NODE_ENV: "development",
    },
    async () => {
      forwarded.length = 0;
      sent.length = 0;
      customerMetadata = { egghead_owner_timeline: "rails@0;cb@1000" };
      // created: 100 is before the flip at 1000, so Rails owns this event.
      const response = await route.POST(signedEvent("customer.subscription.deleted").request());
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { received: true, skipped: "not-owner" });
      assert.deepEqual(sent, []);
      assert.deepEqual(forwarded, []);
    },
  );
});

/** Replace one Stripe SDK resource method on its prototype for the length of `work`. */
async function withStripeReads(
  replies: { charges: (id: string) => unknown; invoices: (id: string) => unknown },
  work: () => Promise<void>,
) {
  const { getStripeProvider } = await import("../apps/web/src/coursebuilder/stripe-provider");
  const stripe: unknown = Reflect.get(getStripeProvider()?.options.paymentsAdapter ?? {}, "stripe");
  const restores = (["charges", "invoices"] as const).map((resource) => {
    const prototype: unknown = Object.getPrototypeOf(Reflect.get(Object(stripe), resource));
    assert.ok(typeof prototype === "object" && prototype !== null);
    const original = Object.getOwnPropertyDescriptor(prototype, "retrieve");
    assert.equal(typeof original?.value, "function");
    Object.defineProperty(prototype, "retrieve", {
      configurable: true,
      writable: true,
      value: async (id: string) => replies[resource](id),
    });
    return () => {
      if (original) Object.defineProperty(prototype, "retrieve", original);
    };
  });
  try {
    await work();
  } finally {
    for (const restore of restores) restore();
  }
}

const localEnv = {
  EGGHEAD_RUNTIME: "local",
  DATABASE_URL: "mysql://root:root@127.0.0.1:3307/coursebuilder_test",
  NODE_ENV: "development",
};

await test("local development: workshop and subscription refunds and disputes reach CourseBuilder and the seam", async () => {
  await withEnv(localEnv, async () => {
    await withStripeReads(
      {
        charges: (id) => ({
          id,
          customer: "cus_synthetic",
          invoice: id === "ch_sub" ? "in_sub" : null,
        }),
        invoices: (id) => ({ id, customer: "cus_synthetic", subscription: "sub_synthetic" }),
      },
      async () => {
        forwarded.length = 0;
        sent.length = 0;
        customerMetadata = { egghead_owner_timeline: "cb@0" };
        const events = [
          signedEvent("charge.refunded", {
            id: "ch_workshop",
            customer: "cus_synthetic",
            invoice: null,
          }),
          signedEvent("charge.dispute.created", { id: "dp_workshop", charge: "ch_workshop" }),
          signedEvent("charge.refunded", {
            id: "ch_sub",
            customer: "cus_synthetic",
            invoice: "in_sub",
          }),
          signedEvent("charge.dispute.created", { id: "dp_sub", charge: "ch_sub" }),
        ];
        const original = console.error;
        console.error = () => {};
        let replies;
        try {
          replies = await Promise.all(events.map((event) => route.POST(event.request())));
        } finally {
          console.error = original;
        }
        assert.deepEqual(
          replies.map((reply) => reply.status),
          [200, 200, 200, 200],
        );
        // Every one reaches CourseBuilder; only the subscription's go to the billing function.
        assert.deepEqual(
          forwarded.map((entry) => entry.body).toSorted(),
          events.map((event) => event.body).toSorted(),
        );
        assert.deepEqual(
          sent
            .map(
              (event) =>
                z
                  .object({ data: z.object({ signal: z.object({ objectId: z.string() }) }) })
                  .parse(event).data.signal.objectId,
            )
            .toSorted(),
          ["ch_sub", "dp_sub"],
        );
      },
    );
  });
});

await test("a CourseBuilder failure is returned as is and the seam does not run", async () => {
  await withEnv(localEnv, async () => {
    forwarded.length = 0;
    sent.length = 0;
    courseBuilderStatus = 500;
    try {
      const response = await route.POST(
        signedEvent("charge.dispute.created", { id: "dp_fail", charge: "ch_sub" }).request(),
      );
      assert.equal(response.status, 500);
      assert.equal(forwarded.length, 1);
      assert.deepEqual(sent, []);
    } finally {
      courseBuilderStatus = 200;
    }
  });
});
