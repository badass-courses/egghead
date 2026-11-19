// /i/:slug/rss.xml: the egghead-next instructor feed
// (egghead-next src/pages/i/[slug]/rss.xml.tsx and src/lib/instructor-feed.ts).
//
// egghead-next built it with the `feed` package (4.2.2) from the legacy
// Typesense collection: the newest 100 documents with instructor.slug = slug.
// Each item's <guid> was `https://egghead.io${document.path}`, with no
// isPermaLink attribute and no enclosure. Paths mix shapes: Rails lessons
// (/lessons/x), playlists (/playlists/x), talks (/talks/x) and CB posts
// (/x~hash). Only the Typesense `path` reproduces them byte for byte, so this
// feed reads the same collection.

import { z } from "zod";

import { PRO_FEED_IMAGE_URL } from "./rails-parity";
import type { RssChannel, RssItem } from "./rss";

export const INSTRUCTOR_PODCAST_LIMIT = 100;
const SITE_URL = "https://egghead.io";

/** Rails instructor slugs are friendly_id slugs; anything else is a 404 (and never reaches a filter). */
export function isInstructorSlug(slug: string) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 120;
}

const nullableString = z.string().nullish();
const nullableNumber = z.union([z.number(), z.string()]).nullish();

/** The legacy content_production fields this feed reads, parsed at the boundary. */
export const instructorPodcastDocumentSchema = z.object({
  path: z.string().min(1),
  title: z.string(),
  summary: nullableString,
  description: nullableString,
  instructor_name: nullableString,
  published_at_timestamp: nullableNumber,
  updated_at_timestamp: nullableNumber,
});

export type InstructorPodcastDocument = z.infer<typeof instructorPodcastDocumentSchema>;

export function parseInstructorPodcastDocuments(documents: readonly unknown[]) {
  return documents.flatMap((document) => {
    const parsed = instructorPodcastDocumentSchema.safeParse(document);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * egghead-next's date rule, kept as-is:
 *   updated_at_timestamp < 17256758682 ? published_at_timestamp * 1000 : published_at_timestamp
 * (seconds for older documents, milliseconds otherwise). Documents without a
 * published timestamp get no pubDate rather than an invalid one.
 */
export function instructorPodcastDate(document: InstructorPodcastDocument): Date | null {
  const published = Number(document.published_at_timestamp);
  if (document.published_at_timestamp == null || !Number.isFinite(published)) return null;
  const updated = Number(document.updated_at_timestamp);
  const millis = updated < 17256758682 ? published * 1000 : published;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A small stand-in for the `remove-markdown` package egghead-next used. */
export function removeMarkdown(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/<[^>]+>/g, "")
    .trim();
}

export function instructorPodcastGuid(path: string) {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

export function instructorPodcastChannel(input: {
  instructorName: string;
  documents: readonly InstructorPodcastDocument[];
  now: Date;
}): RssChannel {
  const title = `${input.instructorName}'s egghead.io Feed`;
  const items = input.documents.slice(0, INSTRUCTOR_PODCAST_LIMIT).map((document): RssItem => {
    const url = instructorPodcastGuid(document.path);
    const date = instructorPodcastDate(document);
    return {
      title: document.title,
      link: url,
      guid: url,
      // The `feed` package wrote Date#toUTCString(), e.g. "Tue, 06 May 2025 16:12:09 GMT".
      pubDate: date ? date.toUTCString() : null,
      description: removeMarkdown(document.summary),
      contentEncoded: removeMarkdown(document.description),
    };
  });

  return {
    title,
    link: SITE_URL,
    // egghead-next sent an empty description; RSS needs one, so the renderer uses the title.
    description: "",
    lastBuildDate: input.now.toUTCString(),
    docs: "https://validator.w3.org/feed/docs/rss2.html",
    generator: "egghead.io",
    // egghead-next pointed at /logo.svg, which 404s; use the image this app ships.
    image: { title, url: PRO_FEED_IMAGE_URL, link: SITE_URL },
    copyright: `All rights reserved ${input.now.getUTCFullYear()}, egghead.io & ${input.instructorName}`,
    items,
  };
}
