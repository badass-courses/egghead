// /i/:slug/rss.xml: the public egghead-next instructor feed, same item GUIDs.
import { connection } from "next/server";

import { instructorPodcastXml } from "../../../../feeds/cached";
import {
  decodeFeedParam,
  feedNotFoundResponse,
  feedUnavailableResponse,
  publicRssResponse,
} from "../../../../feeds/response";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  // Per request from the content cache; never prerendered at build time.
  await connection();
  const slug = decodeFeedParam((await params).slug);
  if (slug === null) return feedNotFoundResponse();

  try {
    const xml = await instructorPodcastXml(slug);
    return xml === null ? feedNotFoundResponse() : publicRssResponse(xml);
  } catch (error) {
    console.error("[feeds] instructor podcast feed failed", error);
    return feedUnavailableResponse();
  }
}
