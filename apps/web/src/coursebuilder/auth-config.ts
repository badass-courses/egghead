import type { NextAuthConfig } from "next-auth";
import GithubProvider from "@auth/core/providers/github";

import { getCourseBuilderAdapter } from "../db/adapter";
import { getEnv } from "../env";

export function isGithubAuthConfigured() {
  const githubClientId = getEnv("GITHUB_CLIENT_ID");
  const githubClientSecret = getEnv("GITHUB_CLIENT_SECRET");

  return Boolean(githubClientId && githubClientSecret);
}

function getAuthProviders() {
  const githubClientId = getEnv("GITHUB_CLIENT_ID");
  const githubClientSecret = getEnv("GITHUB_CLIENT_SECRET");

  if (!githubClientId || !githubClientSecret) return [];

  return [
    GithubProvider({
      clientId: githubClientId,
      clientSecret: githubClientSecret,
      allowDangerousEmailAccountLinking: true,
    }),
  ];
}

export const authConfig = {
  adapter: getCourseBuilderAdapter(),
  providers: getAuthProviders(),
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
  },
  secret: getEnv("AUTH_SECRET") ?? "local-dev-only-egghead-phase-0",
  trustHost: true,
} satisfies NextAuthConfig;
