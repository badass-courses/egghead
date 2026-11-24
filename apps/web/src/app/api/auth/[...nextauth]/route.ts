import { isReadOnlyBeta } from "../../../../runtime";
import { GET as authGet, POST as authPost } from "../../../../server/auth";

const betaReadPaths = new Set(["/api/auth/session", "/api/auth/providers", "/api/auth/csrf"]);

export const GET: typeof authGet = async (request) =>
  isReadOnlyBeta() && !betaReadPaths.has(new URL(request.url).pathname.replace(/\/+$/, ""))
    ? new Response(null, { status: 404 })
    : authGet(request);

export const POST: typeof authPost = async (request) =>
  isReadOnlyBeta() ? new Response(null, { status: 404 }) : authPost(request);
