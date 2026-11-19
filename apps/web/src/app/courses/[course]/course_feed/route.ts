// series#course_feed: a member podcast feed for one course.
import { connection } from "next/server";

import { courseFeedXml } from "../../../../feeds/cached";
import { renderByParam, serveMemberFeed } from "../../../../feeds/response";
import { mysqlFeedMembership, mysqlFeedTokenStore } from "../../../../feeds/token-store";

export async function GET(request: Request, { params }: { params: Promise<{ course: string }> }) {
  // Member feeds are always per request: never prerendered at build time.
  await connection();
  const { course } = await params;
  return serveMemberFeed(
    request,
    { store: mysqlFeedTokenStore, isMember: mysqlFeedMembership },
    renderByParam(course, courseFeedXml),
  );
}
