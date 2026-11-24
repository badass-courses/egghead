import { createAuthJsAdapter, createBetaSessionAdapter } from "../server/auth-js-adapter";
import type { NextAuthConfig } from "next-auth";
import { logger } from "@coursebuilder/utils/logger";

import { getCourseBuilderAdapter } from "../db/adapter";
import { getEggheadRuntime, isReadOnlyBeta } from "../runtime";
import { getEnv } from "../env";
import { claimAnonymousLessonCompletions } from "../progress/anonymous-lesson-progress";
import { createAuthConfig } from "./auth-config-factory";
import { getAuthSecret } from "./auth-secret";
import { isEmailAuthEnabled } from "./email-auth";
import { isEmailDeliveryEnabled } from "./email-delivery";
import { createPostmarkEmailProvider } from "./email-provider";
import { createGithubProvider } from "./github-provider";

const LOCAL_EMAIL_FROM = "egghead development <no-reply@egghead.local>";
const authSecret = getAuthSecret();

export function isGithubAuthConfigured() {
  if (isReadOnlyBeta()) return false;
  const githubClientId = getEnv("GITHUB_CLIENT_ID");
  const githubClientSecret = getEnv("GITHUB_CLIENT_SECRET");

  return Boolean(githubClientId && githubClientSecret);
}

export function isEmailAuthConfigured() {
  if (isReadOnlyBeta()) return false;
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
  if (isReadOnlyBeta()) return [];
  const githubClientId = getEnv("GITHUB_CLIENT_ID");
  const githubClientSecret = getEnv("GITHUB_CLIENT_SECRET");
  const postmarkApiKey = getEnv("POSTMARK_API_KEY");
  const postmarkFromEmail = getEnv("POSTMARK_FROM_EMAIL");
  const providers: NextAuthConfig["providers"] = [];

  if (githubClientId && githubClientSecret) {
    providers.push(
      createGithubProvider({ clientId: githubClientId, clientSecret: githubClientSecret }),
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

async function claimAnonymousProgressOnSignIn(userId: string) {
  try {
    await claimAnonymousLessonCompletions(userId);
  } catch (error) {
    logger.error(
      error instanceof Error ? error : new Error("Unknown anonymous lesson progress claim failure"),
      { operation: "claimAnonymousLessonCompletions" },
    );
  }
}

const adapter = createAuthJsAdapter(getCourseBuilderAdapter());
const readOnlyBeta = isReadOnlyBeta();

export const authConfig = createAuthConfig({
  adapter: readOnlyBeta ? createBetaSessionAdapter(adapter) : adapter,
  providers: getAuthProviders(),
  ...(readOnlyBeta ? {} : { onSignIn: claimAnonymousProgressOnSignIn }),
  secret: authSecret,
}) satisfies NextAuthConfig;
