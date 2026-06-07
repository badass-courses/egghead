import NextCourseBuilder, { type NextCourseBuilderConfig } from "@coursebuilder/next";
import { getCourseBuilderAdapter } from "../db/adapter";
import { getEnv } from "../env";
import { authConfig } from "./auth-config";
import { getCurrentUser } from "./current-user";

export const courseBuilderConfig = {
  baseUrl: getEnv("COURSEBUILDER_URL") ?? getEnv("NEXT_PUBLIC_APP_URL") ?? "http://localhost:3008",
  basePath: "/api/coursebuilder",
  adapter: getCourseBuilderAdapter(),
  providers: [],
  getCurrentUser,
  authConfig,
  callbacks: {
    session: async (request) => ({
      ...request,
      user: await getCurrentUser(),
    }),
  },
} satisfies NextCourseBuilderConfig;

export const { handlers, coursebuilder } = NextCourseBuilder(courseBuilderConfig);
