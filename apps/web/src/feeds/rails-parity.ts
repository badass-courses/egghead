// Rails feed parity rules, ported from egghead-rails app/views/**/*.rss.builder.
//
// GUIDs are the contract: every Rails feed item used the canonical Rails
// permalink as its <guid> (lesson_url / series_url / polymorphic_url with
// host egghead.io over https). Podcast apps and readers dedupe by GUID, so
// these strings must stay byte-identical to what Rails emitted or every
// subscriber re-downloads the whole back catalog after the domain flip.

import type { RssItunesCategory, RssItunesChannel } from "./rss";

export const RAILS_FEED_HOST = "https://egghead.io";

export const RSS_FEED_UTM = "utm_source=rss&utm_medium=feed&utm_campaign=rss_feed";
export const PRO_RSS_FEED_UTM = "utm_source=rss&utm_medium=feed&utm_campaign=pro_rss_feed";

export const FEED_OWNER_EMAIL = "support@egghead.io";
export const FEED_DEFAULT_AUTHOR = "egghead.io";
// Rails served a fingerprinted pro_feed.png from its asset host, which goes
// away with Rails. This image ships in apps/web/public.
export const PRO_FEED_IMAGE_URL = `${RAILS_FEED_HOST}/eggo-watering.png`;

export const ITUNES_CATEGORIES: readonly RssItunesCategory[] = [
  { text: "Technology", children: ["Software How-To"] },
  { text: "Education", children: ["Training"] },
];

/**
 * - lesson: lesson_url -> /lessons/:slug
 * - course: series_url -> /courses/:slug (lessons#feed passes Playlists here too)
 * - playlist: polymorphic_url(playlist) -> /playlists/:slug (instructors#feed only)
 */
export type RailsFeedItemKind = "lesson" | "course" | "playlist";

/** lesson_url(lesson, host: "egghead.io", protocol: "https") */
export function railsLessonUrl(slug: string) {
  return `${RAILS_FEED_HOST}/lessons/${encodeURIComponent(slug)}`;
}

/**
 * series_url(record, host: "egghead.io", protocol: "https").
 * lessons#feed passes Playlist records through series_url, so playlists and
 * series both resolve to /courses/:slug.
 */
export function railsCourseUrl(slug: string) {
  return `${RAILS_FEED_HOST}/courses/${encodeURIComponent(slug)}`;
}

/** playlist_url(playlist, host: "egghead.io", protocol: "https") */
export function railsPlaylistUrl(slug: string) {
  return `${RAILS_FEED_HOST}/playlists/${encodeURIComponent(slug)}`;
}

export function railsItemUrl(kind: RailsFeedItemKind, slug: string) {
  if (kind === "lesson") return railsLessonUrl(slug);
  if (kind === "playlist") return railsPlaylistUrl(slug);
  return railsCourseUrl(slug);
}

/** The <guid> Rails emitted for an item. Never append query strings here. */
export function railsItemGuid(kind: RailsFeedItemKind, slug: string) {
  return railsItemUrl(kind, slug);
}

/** The <link> Rails emitted: the permalink plus the feed's UTM params. */
export function railsItemLink(kind: RailsFeedItemKind, slug: string, utm: string) {
  return `${railsItemUrl(kind, slug)}?${utm}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

/**
 * Ruby Time#to_s(:rfc822): "%a, %d %b %Y %H:%M:%S %z". Rails rendered in
 * Central time; we render the same instant in UTC (+0000), which RSS readers
 * treat identically.
 */
export function rfc822(date: Date): string {
  const weekday = WEEKDAYS[date.getUTCDay()] ?? "Sun";
  const month = MONTHS[date.getUTCMonth()] ?? "Jan";
  return `${weekday}, ${pad2(date.getUTCDate())} ${month} ${date.getUTCFullYear()} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())} +0000`;
}

/** Rails "(published_at - i.minutes)" used to keep course item order stable. */
export function minutesBefore(date: Date, minutes: number) {
  return new Date(date.getTime() - minutes * 60_000);
}

/** ActionView truncate(text, length: 150): total length includes "...". */
export function railsTruncate(value: string, length = 150) {
  if (value.length <= length) return value;
  return `${value.slice(0, length - 3)}...`;
}

/**
 * Rails wrote lesson.duration (integer seconds) straight into itunes:duration.
 * Unknown or zero durations return null so the element is omitted, not empty.
 */
export function itunesDuration(seconds: number | null) {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  return String(Math.round(seconds));
}

export function itunesChannel(input: {
  author: string;
  keywords: string;
  image: string | null;
}): RssItunesChannel {
  return {
    author: input.author,
    keywords: input.keywords,
    explicit: "clean",
    image: input.image,
    ownerName: input.author,
    ownerEmail: FEED_OWNER_EMAIL,
    block: "no",
    categories: ITUNES_CATEGORIES,
  };
}
