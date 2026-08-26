import type { NextAuthConfig } from "next-auth";
import GithubProvider from "@auth/core/providers/github";
import { logger } from "@coursebuilder/core/utils/logger";

import { getCourseBuilderAdapter } from "../db/adapter";
import { getEggheadRuntime } from "../db/local-docker";
import { getEnv } from "../env";
import { claimAnonymousLessonCompletions } from "../progress/anonymous-lesson-progress";
import { isEmailAuthEnabled } from "./email-auth";
import { isEmailDeliveryEnabled } from "./email-delivery";
import { createPostmarkEmailProvider } from "./email-provider";

const LOCAL_EMAIL_FROM = "egghead development <no-reply@egghead.local>";

export function isGithubAuthConfigured() {
  const githubClientId = getEnv("GITHUB_CLIENT_ID");
  const githubClientSecret = getEnv("GITHUB_CLIENT_SECRET");

  return Boolean(githubClientId && githubClientSecret);
}

export function isEmailAuthConfigured() {
  const postmarkApiKey = getEnv("POSTMARK_API_KEY");
  const postmarkFromEmail = getEnv("POSTMARK_FROM_EMAIL");

  return isEmailAuthEnabled({
    deliveryEnabled: isEmailDeliveryEnabled(getEnv("SEND_EMAILS")),
    postmarkApiKey,
    postmarkFromEmail,
    runtime: getEggheadRuntime(),
  });
}

function getAuthProviders(): NextAuthConfig["providers"] {
  const githubClientId = getEnv("GITHUB_CLIENT_ID");
  const githubClientSecret = getEnv("GITHUB_CLIENT_SECRET");
  const postmarkApiKey = getEnv("POSTMARK_API_KEY");
  const postmarkFromEmail = getEnv("POSTMARK_FROM_EMAIL");
  const providers: NextAuthConfig["providers"] = [];

  if (githubClientId && githubClientSecret) {
    providers.push(
      GithubProvider({
        clientId: githubClientId,
        clientSecret: githubClientSecret,
        allowDangerousEmailAccountLinking: true,
      }),
    );
  }

  if (isEmailAuthConfigured()) {
    providers.push(
      createPostmarkEmailProvider({
        apiKey: postmarkApiKey,
        from: postmarkFromEmail ?? LOCAL_EMAIL_FROM,
      }),
    );
  }

  return providers;
}

export const authConfig = {
  adapter: getCourseBuilderAdapter(),
  providers: getAuthProviders(),
  events: {
    signIn: async ({ user }) => {
      if (!user.id) return;

      try {
        await claimAnonymousLessonCompletions(user.id);
      } catch (error) {
        logger.error(
          error instanceof Error
            ? error
            : new Error("Unknown anonymous lesson progress claim failure"),
          { operation: "claimAnonymousLessonCompletions" },
        );
      }
    },
  },
  callbacks: {
    session: ({ session, user }) => {
      if (session.user && user.id) {
        session.user.id = user.id;
        session.user.role =
          user.role === "admin" || user.role === "contributor" ? user.role : "user";
      }

      return session;
    },
  },
  pages: {
    error: "/login",
    signIn: "/login",
    verifyRequest: "/check-your-email",
  },
  secret: getEnv("AUTH_SECRET") ?? "local-dev-only-egghead-phase-0",
  trustHost: true,
} satisfies NextAuthConfig;
