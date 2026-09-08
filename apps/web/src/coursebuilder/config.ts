import NextCourseBuilder, { type NextCourseBuilderConfig } from "@coursebuilder/next";
import type { NextRequest } from "next/server";
import { getCourseBuilderAdapter } from "../db/adapter";
import { getEnv } from "../env";
import { authConfig } from "./auth-config";
import { getCurrentUser } from "./current-user";
import { inngest } from "../inngest/client";
import { getStripeProvider } from "./stripe-provider";
import { createCourseBuilderHttpHandler } from "./http-policy";

const stripeProvider = getStripeProvider();

export const courseBuilderConfig = {
  baseUrl: getEnv("COURSEBUILDER_URL") ?? getEnv("NEXT_PUBLIC_APP_URL") ?? "http://localhost:3008",
  basePath: "/api/coursebuilder",
  adapter: getCourseBuilderAdapter(),
  providers: stripeProvider ? [stripeProvider] : [],
  inngest,
  getCurrentUser: async () => {
    const user = await getCurrentUser();
    if (!user) return null;
    return {
      ...user,
      email: user.email ?? "",
      memberships: null,
      roles: [],
      organizationRoles: [],
    };
  },
  authConfig,
  callbacks: {
    session: async (request) => ({
      ...request,
      user: await getCurrentUser(),
    }),
  },
} satisfies NextCourseBuilderConfig;

const configuredCourseBuilder = NextCourseBuilder(courseBuilderConfig);
export const coursebuilder = configuredCourseBuilder.coursebuilder;
const guardedHandler = createCourseBuilderHttpHandler<NextRequest>(
  async () => ({
    GET: (request) => configuredCourseBuilder.handlers.GET(request),
  }),
  // Load the mutation provider only after the HTTP runtime boundary allows it.
  async (request) => (await import("./stripe-webhook")).handleStripeWebhook(request),
);
export const handlers = { GET: guardedHandler, POST: guardedHandler };
