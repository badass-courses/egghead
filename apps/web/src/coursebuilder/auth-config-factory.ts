import type { Adapter } from "@auth/core/adapters";
import type { NextAuthConfig } from "next-auth";

import { GITHUB_EMAIL_UNVERIFIED_ERROR } from "./github-provider";

type CreateAuthConfigOptions = {
  adapter: Adapter;
  providers: NextAuthConfig["providers"];
  onSignIn?: (userId: string) => Promise<void>;
  secret?: string | undefined;
};

/**
 * Build the egghead Auth.js config from its parts.
 *
 * Kept free of database and env imports so the account-linking contract can
 * run the real callbacks against a test adapter.
 */
export function createAuthConfig({
  adapter,
  providers,
  onSignIn,
  secret,
}: CreateAuthConfigOptions) {
  return {
    adapter,
    providers,
    events: {
      signIn: async ({ user }) => {
        if (!user.id || !onSignIn) return;
        await onSignIn(user.id);
      },
    },
    callbacks: {
      /**
       * A GitHub identity with no verified email may still sign in by its
       * linked GitHub id. Without that link there is nothing safe to match
       * or create, so the user gets a specific `/login` message.
       */
      signIn: async ({ account, profile }) => {
        if (account?.provider !== "github" || profile?.email) return true;

        const linkedUser = await adapter.getUserByAccount?.({
          provider: account.provider,
          providerAccountId: account.providerAccountId,
        });

        return linkedUser ? true : `/login?error=${GITHUB_EMAIL_UNVERIFIED_ERROR}`;
      },
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
    ...(secret ? { secret } : {}),
    trustHost: true,
  } satisfies NextAuthConfig;
}
