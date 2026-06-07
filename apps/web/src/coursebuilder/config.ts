import { authConfig } from "@/coursebuilder/auth-config";
import { getCurrentUser } from "@/coursebuilder/current-user";
import { getCourseBuilderAdapter } from "@/db/adapter";

import NextCourseBuilder, {
  type NextCourseBuilderConfig,
} from "@coursebuilder/next";

export const courseBuilderConfig = {
  baseUrl:
    process.env.COURSEBUILDER_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3008",
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

export const {
  handlers,
  coursebuilder,
} = NextCourseBuilder(courseBuilderConfig);
