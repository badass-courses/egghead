// instructors#feed: a member podcast feed of one instructor's content.
import { connection } from "next/server";

import { instructorFeedXml } from "../../../../feeds/cached";
import { renderByParam, serveMemberFeed } from "../../../../feeds/response";
import { mysqlFeedMembership, mysqlFeedTokenStore } from "../../../../feeds/token-store";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Member feeds are always per request: never prerendered at build time.
  await connection();
  const { id } = await params;
  return serveMemberFeed(
    request,
    { store: mysqlFeedTokenStore, isMember: mysqlFeedMembership },
    renderByParam(id, instructorFeedXml),
  );
}
