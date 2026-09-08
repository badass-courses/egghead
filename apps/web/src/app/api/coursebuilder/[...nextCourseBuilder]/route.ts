import type { NextRequest } from "next/server";
import { createCourseBuilderHttpHandler } from "../../../../coursebuilder/http-policy";

const handler = createCourseBuilderHttpHandler<NextRequest>(
  // Static config import initializes auth/DB before a denied request can be rejected.
  async () => (await import("../../../../coursebuilder/config")).handlers,
  async (request) => {
    const { handleStripeWebhook } = await import("../../../../coursebuilder/stripe-webhook");
    return handleStripeWebhook(request);
  },
);

export const GET = handler;
export const POST = handler;
