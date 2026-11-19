// lessons#pro_feed: the member podcast feed (?user_email=&user_token=&tech=).
import { connection } from "next/server";

import { proFeedXml } from "../../../feeds/cached";
import { proFeedTechKey, serveMemberFeed } from "../../../feeds/response";
import { mysqlFeedMembership, mysqlFeedTokenStore } from "../../../feeds/token-store";

export async function GET(request: Request) {
  // Member feeds are always per request: never prerendered at build time.
  await connection();
  return serveMemberFeed(
    request,
    { store: mysqlFeedTokenStore, isMember: mysqlFeedMembership },
    () => proFeedXml(proFeedTechKey(request)),
  );
}
