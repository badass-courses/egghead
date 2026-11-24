import { isReadOnlyBeta } from "../../../../runtime";
import { GET as authGet, POST as authPost } from "../../../../server/auth";

export const GET: typeof authGet = async (request) => {
  if (!isReadOnlyBeta()) return authGet(request);
  if (new URL(request.url).pathname.replace(/\/+$/, "") === "/api/auth/session") {
    return Response.json({ user: null }, { headers: { "Cache-Control": "no-store" } });
  }
  return new Response(null, { status: 404 });
};

export const POST: typeof authPost = async (request) =>
  isReadOnlyBeta() ? new Response(null, { status: 404 }) : authPost(request);
