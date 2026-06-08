import NextAuth, { type DefaultSession, type NextAuthConfig } from "next-auth";

import { authConfig } from "../coursebuilder/auth-config";

declare module "next-auth" {
  interface Session extends DefaultSession {
    user: {
      id: string;
      role: "admin" | "contributor" | "user";
    } & DefaultSession["user"];
  }

  interface User {
    role?: "admin" | "contributor" | "user";
  }
}

export const authOptions = authConfig satisfies NextAuthConfig;

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
} = NextAuth(authOptions);
