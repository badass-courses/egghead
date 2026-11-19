// Cached feed bodies. Auth happens per request in the route; the XML is the
// same for every member, so it is cached by content key only. Rails cached
// pro_feed for 90 minutes and course feeds for a week.
//
// A miss (unknown slug) is cached for minutes, not hours, so a course that is
// published or renamed shortly after a poll shows up quickly. Each function
// runs exactly one cacheLife call per invocation, as Next requires.

import { cacheLife, cacheTag } from "next/cache";

import {
  readFeedCourse,
  readInstructorFeed,
  readProFeedLessons,
  readPublicFeedEntries,
} from "./content";
import {
  courseFeedChannel,
  instructorFeedChannel,
  playlistFeedChannel,
  proFeedChannel,
  publicFeedChannel,
} from "./feeds";
import { instructorPodcastChannel, isInstructorSlug } from "./instructor-podcast";
import { typesenseInstructorPodcastSource } from "./instructor-podcast-source";
import { renderRss } from "./rss";

export async function publicFeedXml(): Promise<string> {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-content");
  cacheTag("egghead-feed:public");

  return renderRss(publicFeedChannel(await readPublicFeedEntries()));
}

/** techKey is the sorted, comma-joined tag list ("" for no filter). */
export async function proFeedXml(techKey: string): Promise<string> {
  "use cache";
  cacheLife("hours");
  cacheTag("egghead-content");
  cacheTag("egghead-feed:pro");

  const tags = techKey ? techKey.split(",") : [];
  return renderRss(proFeedChannel(await readProFeedLessons(tags), new Date()));
}

export async function courseFeedXml(param: string): Promise<string | null> {
  "use cache";
  cacheTag("egghead-content");
  cacheTag(`egghead-feed:course:${param}`);

  const course = await readFeedCourse(param, "course");
  if (course) cacheLife("hours");
  else cacheLife("minutes");
  return course ? renderRss(courseFeedChannel(course)) : null;
}

export async function playlistFeedXml(param: string): Promise<string | null> {
  "use cache";
  cacheTag("egghead-content");
  cacheTag(`egghead-feed:playlist:${param}`);

  const course = await readFeedCourse(param, "playlist");
  if (course) cacheLife("hours");
  else cacheLife("minutes");
  return course ? renderRss(playlistFeedChannel(course)) : null;
}

export async function instructorFeedXml(slug: string): Promise<string | null> {
  "use cache";
  cacheTag("egghead-content");
  cacheTag(`egghead-feed:instructor:${slug}`);

  const feed = await readInstructorFeed(slug);
  if (feed) cacheLife("hours");
  else cacheLife("minutes");
  return feed ? renderRss(instructorFeedChannel(feed.instructor, feed.entries)) : null;
}

/**
 * /i/:slug/rss.xml (egghead-next instructor feed). The slug is validated
 * before the cached function runs, so garbage paths create no cache entry or
 * tag and never reach Typesense.
 */
export async function instructorPodcastXml(slug: string): Promise<string | null> {
  if (!isInstructorSlug(slug)) return null;
  return cachedInstructorPodcastXml(slug);
}

async function cachedInstructorPodcastXml(slug: string): Promise<string | null> {
  "use cache";
  cacheTag("egghead-content");
  cacheTag(`egghead-feed:instructor-podcast:${slug}`);

  const feed = await typesenseInstructorPodcastSource(slug);
  if (feed) cacheLife("hours");
  else cacheLife("minutes");
  return feed ? renderRss(instructorPodcastChannel({ ...feed, now: new Date() })) : null;
}
