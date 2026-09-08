import {
  assertCommerceWritesAllowed,
  assertDatabaseUrlForRuntime,
  RuntimePolicyError,
} from "../db/local-docker";

export type CourseBuilderHttpHandlers<RequestType extends Request = Request> = {
  GET(request: RequestType): Promise<Response>;
};

export const courseBuilderHttpOperations = {
  GET: ["/api/coursebuilder/session", "/api/coursebuilder/purchases"],
  POST: ["/api/coursebuilder/webhook/stripe"],
  unknownOperations: "denied",
  accountAuthentication: "/api/auth",
  checkout: "authenticated pricing server action only",
} as const;

/** Guard before loading configuration or reading bodies. Generic published
 * checkout bypasses the app reservation, srt bypasses lesson access, and the
 * published webhook parser does not await signature verification.
 */
export function createCourseBuilderHttpHandler<RequestType extends Request = Request>(
  loadHandlers: () => Promise<CourseBuilderHttpHandlers<RequestType>>,
  stripeWebhook: (request: RequestType) => Promise<Response>,
) {
  return async (request: RequestType): Promise<Response> => {
    const pathname = new URL(request.url).pathname;
    try {
      assertDatabaseUrlForRuntime();
      if (
        request.method === "GET" &&
        courseBuilderHttpOperations.GET.some((path) => path === pathname)
      ) {
        const handlers = await loadHandlers();
        return await handlers.GET(request);
      }
      if (request.method === "POST" && pathname === "/api/coursebuilder/webhook/stripe") {
        assertCommerceWritesAllowed();
        return await stripeWebhook(request);
      }
      return Response.json({ error: "Unsupported CourseBuilder operation" }, { status: 403 });
    } catch (error) {
      if (!(error instanceof RuntimePolicyError)) throw error;
      return Response.json({ error: "Operation blocked by runtime policy" }, { status: 403 });
    }
  };
}
