// lessons#feed: the public egghead feed, formerly served by Rails at /feed.
import { connection } from "next/server";

import { publicFeedXml } from "../../feeds/cached";
import { feedUnavailableResponse, publicRssResponse } from "../../feeds/response";

export async function GET() {
  // Render per request (from the hours-long content cache), never at build
  // time, so a build without DB access cannot bake a 503 into a static feed.
  await connection();

  try {
    return publicRssResponse(await publicFeedXml());
  } catch (error) {
    console.error("[feeds] public feed failed", error);
    return feedUnavailableResponse();
  }
}
