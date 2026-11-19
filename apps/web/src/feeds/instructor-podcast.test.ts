import { describe, expect, it } from "vitest";

import {
  instructorPodcastChannel,
  instructorPodcastDate,
  isInstructorSlug,
  parseInstructorPodcastDocuments,
  removeMarkdown,
} from "./instructor-podcast";
import {
  instructorFeedCollection,
  InstructorPodcastSourceUnavailable,
  typesenseInstructorPodcastSource,
} from "./instructor-podcast-source";
import { renderRss } from "./rss";
import { child, childText, children, parseXml } from "./xml-test-parser";

// Synthetic legacy Typesense documents covering every path shape the live
// egghead-next feed emits: Rails lessons, playlists, talks and CB posts.
const DOCUMENTS = parseInstructorPodcastDocuments([
  {
    path: "/fixture-cb-post~ab12c",
    title: "CB post",
    summary: "**Bold** summary with a [link](https://example.test).",
    description: "# Heading\n\nBody `code`.",
    instructor_name: "Ada  Fixture",
    published_at_timestamp: 1_746_547_929_000,
    updated_at_timestamp: 1_746_547_929_000,
  },
  {
    path: "/lessons/fixture-rails-lesson",
    title: "Rails lesson & friends",
    summary: "Lesson summary.",
    description: "",
    instructor_name: "Ada  Fixture",
    published_at_timestamp: 1_600_000_000,
    updated_at_timestamp: 1_600_000_000,
  },
  { path: "/playlists/fixture-playlist", title: "Playlist", published_at_timestamp: null },
  { path: "/talks/fixture-talk", title: "Talk", published_at_timestamp: "1500000000" },
  { title: "No path, dropped" },
]);

const NOW = new Date("2026-11-19T05:00:00.000Z");

function renderFixture() {
  return parseXml(
    renderRss(
      instructorPodcastChannel({ instructorName: "Ada Fixture", documents: DOCUMENTS, now: NOW }),
    ),
  );
}

describe("/i/:slug/rss.xml parity with egghead-next", () => {
  it("uses https://egghead.io + document.path as the GUID for every path shape", () => {
    const channel = child(renderFixture(), "channel");
    if (!channel) throw new Error("no channel");
    const items = children(channel, "item");
    expect(items.map((item) => childText(item, "guid"))).toEqual([
      "https://egghead.io/fixture-cb-post~ab12c",
      "https://egghead.io/lessons/fixture-rails-lesson",
      "https://egghead.io/playlists/fixture-playlist",
      "https://egghead.io/talks/fixture-talk",
    ]);
    for (const item of items) {
      // feed@4.2.2 wrote a bare <guid> (no isPermaLink) and no enclosure.
      expect(child(item, "guid")?.attrs).toEqual({});
      expect(child(item, "enclosure")).toBeUndefined();
      expect(childText(item, "link")).toBe(childText(item, "guid"));
    }
  });

  it("keeps egghead-next's seconds-or-milliseconds date rule and toUTCString format", () => {
    const channel = child(renderFixture(), "channel");
    if (!channel) throw new Error("no channel");
    const pubDates = children(channel, "item").map((item) => childText(item, "pubDate"));
    expect(pubDates).toEqual([
      "Tue, 06 May 2025 16:12:09 GMT",
      "Sun, 13 Sep 2020 12:26:40 GMT",
      undefined,
      // No updated_at_timestamp: egghead-next's `Number(undefined) < …` is false,
      // so seconds were read as milliseconds. Kept, because readers saw it.
      "Sun, 18 Jan 1970 08:40:00 GMT",
    ]);
    const [first] = DOCUMENTS;
    if (!first) throw new Error("no document");
    expect(instructorPodcastDate({ ...first, published_at_timestamp: "not a number" })).toBeNull();
  });

  it("writes plain-text description and content:encoded with the namespace declared", () => {
    const rss = renderFixture();
    expect(rss.attrs["xmlns:content"]).toBe("http://purl.org/rss/1.0/modules/content/");
    const channel = child(rss, "channel");
    if (!channel) throw new Error("no channel");
    expect(childText(channel, "title")).toBe("Ada Fixture's egghead.io Feed");
    // egghead-next's empty description falls back to the title: no empty elements.
    expect(childText(channel, "description")).toBe("Ada Fixture's egghead.io Feed");
    expect(child(channel, "image")).toBeDefined();
    const [first, second] = children(channel, "item");
    expect(first && childText(first, "description")).toBe("Bold summary with a link.");
    expect(first && childText(first, "content:encoded")).toBe("Heading\n\nBody code.");
    expect(second && child(second, "content:encoded")).toBeUndefined();
    expect(second && childText(second, "title")).toBe("Rails lesson & friends");
  });

  it("drops documents without a path and strips markdown", () => {
    expect(DOCUMENTS).toHaveLength(4);
    expect(removeMarkdown("![img](x.png) _em_ > quote")).toBe("em > quote");
    expect(removeMarkdown(null)).toBe("");
  });

  it("only accepts slug-shaped instructor ids, so nothing reaches the Typesense filter", async () => {
    expect(isInstructorSlug("ada-fixture")).toBe(true);
    expect(isInstructorSlug("ada-fixture-2")).toBe(true);
    for (const bad of ["Ada", "ada fixture", "ada&&x:=y", "ada,", "-ada", "ada--x", ""]) {
      expect(isInstructorSlug(bad), bad).toBe(false);
    }
    await expect(typesenseInstructorPodcastSource("ada&&x:=y")).resolves.toBeNull();
  });

  it("reads content_production even when search points at another collection", () => {
    const saved = { ...process.env };
    process.env["TYPESENSE_COLLECTION_NAME"] = "egghead_content_migration_v1";
    delete process.env["EGGHEAD_INSTRUCTOR_FEED_TYPESENSE_COLLECTION"];
    try {
      expect(instructorFeedCollection()).toBe("content_production");
      process.env["EGGHEAD_INSTRUCTOR_FEED_TYPESENSE_COLLECTION"] = "content_staging";
      expect(instructorFeedCollection()).toBe("content_staging");
    } finally {
      process.env = saved;
    }
  });

  it("refuses to serve without a Typesense host and key (retryable 503)", async () => {
    const saved = { ...process.env };
    delete process.env["NEXT_PUBLIC_TYPESENSE_HOST"];
    delete process.env["NEXT_PUBLIC_TYPESENSE_API_KEY"];
    try {
      await expect(typesenseInstructorPodcastSource("ada-fixture")).rejects.toBeInstanceOf(
        InstructorPodcastSourceUnavailable,
      );
    } finally {
      process.env = saved;
    }
  });
});
