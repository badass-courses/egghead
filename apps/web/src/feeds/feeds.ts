// Pure feed builders: CourseBuilder content records in, Rails-shaped RSS out.
// Each builder mirrors one egghead-rails view; see rails-parity.ts for the
// shared GUID and formatting rules.

import {
  FEED_DEFAULT_AUTHOR,
  PRO_FEED_IMAGE_URL,
  PRO_RSS_FEED_UTM,
  RAILS_FEED_HOST,
  RSS_FEED_UTM,
  itunesChannel,
  itunesDuration,
  minutesBefore,
  railsCourseUrl,
  railsItemGuid,
  railsItemLink,
  railsPlaylistUrl,
  railsTruncate,
  rfc822,
  type RailsFeedItemKind,
} from "./rails-parity";
import type { RssChannel, RssEnclosure, RssItem } from "./rss";

export const PUBLIC_FEED_LIMIT = 200;
export const PRO_FEED_LIMIT = 400;

export type FeedLesson = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  publishedAt: Date | null;
  createdAt: Date;
  durationSeconds: number | null;
  instructorName: string | null;
  primaryTag: string | null;
  muxPlaybackId: string | null;
  mp4FileSize: number | null;
};

export type FeedCourse = {
  id: string;
  slug: string;
  title: string;
  description: string;
  publishedAt: Date | null;
  createdAt: Date;
  instructorName: string | null;
  imageUrl: string | null;
  primaryTag: string | null;
  /**
   * The Rails model this CB course came from. CB courses are Rails playlists
   * (`eggheadPlaylistId`); a course carrying a Rails Series id came from a
   * Series. Rails URL helpers differ by model, so this decides GUIDs.
   */
  railsOrigin: "playlist" | "series";
  lessons: readonly FeedLesson[];
};

export type FeedInstructor = {
  slug: string;
  fullName: string;
  bioShort: string;
  avatarUrl: string | null;
};

/**
 * Podcast directories want a channel image. Rails always had one (cover,
 * avatar or pro_feed.png); use the first real candidate, else the egghead image.
 */
export function podcastImage(...candidates: ReadonlyArray<string | null | undefined>) {
  for (const candidate of candidates) {
    if (candidate && candidate.trim()) return candidate.trim();
  }
  return PRO_FEED_IMAGE_URL;
}

/** Rails fell back to the "egghead" tag when content had none. */
function tagLabel(tag: string | null) {
  return tag ?? "egghead";
}

/**
 * Rails enclosures were signed CloudFront MP4 URLs that expired; they are tied
 * to Rails' AWS signer. CourseBuilder video lives in Mux with public playback
 * and mp4_support "standard" (egghead-next get-mux-options), and egghead-next
 * already serves member downloads from this exact URL shape.
 */
export function muxMp4Url(playbackId: string) {
  return `https://stream.mux.com/${encodeURIComponent(playbackId)}/high.mp4`;
}

export function lessonEnclosure(lesson: FeedLesson): RssEnclosure | null {
  if (!lesson.muxPlaybackId) return null;
  return {
    url: muxMp4Url(lesson.muxPlaybackId),
    length: lesson.mp4FileSize ?? 0,
    type: "video/mp4",
  };
}

function podcastLessonItem(input: {
  lesson: FeedLesson;
  title: string;
  pubDate: Date | null;
  author: string;
}): RssItem {
  const { lesson } = input;

  return {
    title: input.title,
    description: lesson.summary,
    pubDate: input.pubDate ? rfc822(input.pubDate) : null,
    enclosure: lessonEnclosure(lesson),
    link: railsItemLink("lesson", lesson.slug, PRO_RSS_FEED_UTM),
    guid: railsItemGuid("lesson", lesson.slug),
    itunes: {
      author: input.author,
      subtitle: railsTruncate(lesson.summary),
      summary: lesson.summary,
      explicit: "no",
      duration: itunesDuration(lesson.durationSeconds),
    },
  };
}

// --- lessons#feed (/feed, /lessons/feed) -----------------------------------

export type PublicFeedEntry =
  | { kind: "lesson"; lesson: FeedLesson }
  | { kind: "course"; course: FeedCourse };

function entryDate(entry: PublicFeedEntry) {
  const record = entry.kind === "lesson" ? entry.lesson : entry.course;
  return record.publishedAt ?? record.createdAt;
}

/**
 * Rails: standalone published lessons plus published playlists, merged, sorted
 * by published_at desc, first 200. Courses are titled "[Course] tag: title".
 */
export function publicFeedChannel(entries: readonly PublicFeedEntry[]): RssChannel {
  const sorted = entries
    .toSorted((a, b) => entryDate(b).getTime() - entryDate(a).getTime())
    .slice(0, PUBLIC_FEED_LIMIT);

  return {
    title: "egghead.io - Bite-sized Web Development Video Tutorials & Training",
    description: "Awesome lessons on modern web tools that you use to get work done.",
    link: "https://egghead.io/q",
    items: sorted.map((entry): RssItem => {
      if (entry.kind === "lesson") {
        const { lesson } = entry;
        return {
          title: `${tagLabel(lesson.primaryTag)}: ${lesson.title}`,
          description: lesson.summary,
          link: railsItemLink("lesson", lesson.slug, RSS_FEED_UTM),
          guid: railsItemGuid("lesson", lesson.slug),
          pubDate: rfc822(entryDate(entry)),
        };
      }

      const { course } = entry;
      return {
        title: `[Course] ${tagLabel(course.primaryTag)}: ${course.title}`,
        description: course.description,
        link: railsItemLink("course", course.slug, RSS_FEED_UTM),
        guid: railsItemGuid("course", course.slug),
        pubDate: rfc822(entryDate(entry)),
      };
    }),
  };
}

// --- lessons#pro_feed (/lessons/pro_feed) ----------------------------------

/** Rails: newest 400 published lessons, optionally filtered by ?tech=a,b. */
export function proFeedChannel(lessons: readonly FeedLesson[], now: Date): RssChannel {
  const items = lessons.slice(0, PRO_FEED_LIMIT);
  // Rails: (@lessons.first.try(:created_at) || Time.zone.now).to_s(:rfc822)
  const pubDate = rfc822(items[0]?.createdAt ?? now);

  return {
    title: "egghead.io PRO member lessons",
    link: "https://egghead.io",
    description: "Bite-sized web development lessons to feed your hungry brain.",
    language: "en",
    pubDate,
    lastBuildDate: pubDate,
    itunes: itunesChannel({
      author: FEED_DEFAULT_AUTHOR,
      keywords: "web development, angularjs, screencasts",
      image: PRO_FEED_IMAGE_URL,
    }),
    items: items.map((lesson) =>
      podcastLessonItem({
        lesson,
        title: `${tagLabel(lesson.primaryTag)} - ${lesson.title}`,
        // Rails printed published_at.to_s (not RFC 822); RFC 822 is the valid
        // RSS form and readers order by it, not by GUID.
        pubDate: lesson.publishedAt ?? lesson.createdAt,
        author: lesson.instructorName ?? FEED_DEFAULT_AUTHOR,
      }),
    ),
  };
}

/** Parse Rails' ?tech=react,redux filter into tag names. */
export function proFeedTechTags(raw: string | null) {
  return (raw ?? "")
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 20);
}

// --- series#course_feed (/courses/:id/course_feed) -------------------------

export function courseFeedChannel(course: FeedCourse): RssChannel {
  const author = course.instructorName ?? FEED_DEFAULT_AUTHOR;

  return {
    title: `[egghead.io] ${course.title}`,
    link: `${railsCourseUrl(course.slug)}?${PRO_RSS_FEED_UTM}`,
    description: course.description,
    language: "en",
    // Rails printed an empty pubDate for unpublished series; omit it instead.
    pubDate: course.publishedAt ? rfc822(course.publishedAt) : null,
    itunes: itunesChannel({
      author,
      keywords: "web development, screencasts",
      image: podcastImage(course.imageUrl),
    }),
    items: course.lessons.map((lesson, index) =>
      podcastLessonItem({
        lesson,
        title: lesson.title,
        pubDate: course.publishedAt ? minutesBefore(course.publishedAt, index) : null,
        author: lesson.instructorName ?? FEED_DEFAULT_AUTHOR,
      }),
    ),
  };
}

// --- playlists#playlist_feed (/playlists/:id/playlist_feed) ----------------

export function playlistFeedChannel(course: FeedCourse): RssChannel {
  // Rails keyed playlist dates off playlist.created_at, not published_at.
  const created = course.createdAt;

  return {
    title: `[egghead.io] ${course.title}`,
    link: `${railsPlaylistUrl(course.slug)}?${PRO_RSS_FEED_UTM}`,
    description: course.description,
    language: "en",
    pubDate: rfc822(created),
    itunes: itunesChannel({
      author: FEED_DEFAULT_AUTHOR,
      keywords: "web development, screencasts",
      // Rails emitted no image for playlists; podcast apps need one.
      image: podcastImage(course.imageUrl),
    }),
    items: course.lessons.map((lesson, index) =>
      podcastLessonItem({
        lesson,
        title: lesson.title,
        pubDate: minutesBefore(created, index),
        author: lesson.instructorName ?? FEED_DEFAULT_AUTHOR,
      }),
    ),
  };
}

// --- instructors#feed (/instructors/:id/feed) ------------------------------

export type InstructorFeedEntry =
  | { kind: "lesson"; lesson: FeedLesson }
  | { kind: "course"; course: FeedCourse };

/**
 * instructors#feed used polymorphic_url: a Series resolves through series_url
 * (/courses/:slug) and a Playlist through playlist_url (/playlists/:slug).
 */
export function instructorEntryKind(entry: InstructorFeedEntry): RailsFeedItemKind {
  if (entry.kind === "lesson") return "lesson";
  return entry.course.railsOrigin === "series" ? "course" : "playlist";
}

function instructorEntryRecord(entry: InstructorFeedEntry) {
  return entry.kind === "lesson" ? entry.lesson : entry.course;
}

/**
 * Rails: the instructor's published courses, indexed playlists and standalone
 * lessons, sorted by created_at ascending. Items use polymorphic_url, so a
 * playlist GUID is /playlists/:slug here (unlike lessons#feed).
 */
export function instructorFeedChannel(
  instructor: FeedInstructor,
  entries: readonly InstructorFeedEntry[],
): RssChannel {
  const sorted = entries.toSorted(
    (a, b) =>
      instructorEntryRecord(a).createdAt.getTime() - instructorEntryRecord(b).createdAt.getTime(),
  );

  return {
    title: `[egghead.io] ${instructor.fullName}`,
    link: `${RAILS_FEED_HOST}/instructors/${encodeURIComponent(instructor.slug)}?${PRO_RSS_FEED_UTM}`,
    description: instructor.bioShort,
    language: "en",
    itunes: itunesChannel({
      author: instructor.fullName,
      keywords: "web development, screencasts",
      image: podcastImage(instructor.avatarUrl),
    }),
    items: sorted.map((entry, index): RssItem => {
      const record = instructorEntryRecord(entry);
      const kind = instructorEntryKind(entry);
      const summary = entry.kind === "lesson" ? entry.lesson.summary : entry.course.description;
      const pubDate = record.publishedAt ? rfc822(minutesBefore(record.publishedAt, index)) : null;

      return {
        title: record.title,
        description: summary,
        pubDate,
        enclosure: entry.kind === "lesson" ? lessonEnclosure(entry.lesson) : null,
        link: railsItemLink(kind, record.slug, PRO_RSS_FEED_UTM),
        guid: railsItemGuid(kind, record.slug),
        itunes: {
          author: instructor.fullName,
          subtitle: railsTruncate(summary),
          summary,
          explicit: "no",
          duration: itunesDuration(
            entry.kind === "lesson"
              ? entry.lesson.durationSeconds
              : sumDurations(entry.course.lessons),
          ),
        },
      };
    }),
  };
}

function sumDurations(lessons: readonly FeedLesson[]) {
  let total = 0;
  for (const lesson of lessons) total += lesson.durationSeconds ?? 0;
  return total;
}
