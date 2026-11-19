import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { assertReadOnlyStatement } from "../db/local-docker";
import {
  diffFeedItems,
  formatParityReport,
  guidPath,
  missReason,
  parseFeedItems,
  slugSuffixId,
  type CbSlugFacts,
} from "./parity";

// Shaped like the Rails lessons#feed view: self-closing description, utm link,
// GUID without utm, rfc822 dates in Rails' zone.
const RAILS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>egghead.io - Bite-sized Web Development Video Tutorials &amp; Training</title>
    <description>Awesome lessons on modern web tools that you use to get work done.</description>
    <link>https://egghead.io/q</link>
    <item>
      <title>egghead: Newer than snapshot</title>
      <description>New.</description>
      <link>https://egghead.io/lessons/newer~aaaaa?utm_source=rss&amp;utm_medium=feed&amp;utm_campaign=rss_feed</link>
      <guid>https://egghead.io/lessons/newer~aaaaa</guid>
      <pubDate>Tue, 23 Jun 2026 23:44:07 -0500</pubDate>
    </item>
    <item>
      <title>[Course] threejs: Fixture course</title>
      <description/>
      <link>https://egghead.io/courses/fixture-course~bbbbb?utm_source=rss&amp;utm_medium=feed&amp;utm_campaign=rss_feed</link>
      <guid>https://egghead.io/courses/fixture-course~bbbbb</guid>
      <pubDate>Tue, 14 Apr 2026 13:21:03 -0500</pubDate>
    </item>
    <item>
      <title>react: Missing lesson</title>
      <description>Gone.</description>
      <link>https://egghead.io/lessons/missing-lesson?utm_source=rss</link>
      <guid>https://egghead.io/lessons/missing-lesson</guid>
      <pubDate>Mon, 24 Feb 2025 16:23:03 -0600</pubDate>
    </item>
  </channel>
</rss>`;

const SNAPSHOT = new Date("2026-06-08T00:00:00Z");

describe("feed parity (judge #9)", () => {
  it("parses Rails items and keeps GUIDs exact", () => {
    const items = parseFeedItems(RAILS_XML);
    expect(items.map((item) => item.guid)).toEqual([
      "https://egghead.io/lessons/newer~aaaaa",
      "https://egghead.io/courses/fixture-course~bbbbb",
      "https://egghead.io/lessons/missing-lesson",
    ]);
    expect(items[1]?.pubDate?.toISOString()).toBe("2026-04-14T18:21:03.000Z");
    expect(guidPath("https://egghead.io/lessons/newer~aaaaa")).toEqual({
      kind: "lessons",
      slug: "newer~aaaaa",
    });
  });

  it("buckets items newer than the snapshot, then reports misses, extras and date drift", () => {
    const rails = parseFeedItems(RAILS_XML);
    const diff = diffFeedItems({
      rails,
      snapshotNewest: SNAPSHOT,
      cb: [
        {
          guid: "https://egghead.io/courses/fixture-course~bbbbb",
          title: "[Course] threejs: Fixture course",
          pubDate: new Date("2026-04-14T18:21:04.000Z"),
        },
        {
          guid: "https://egghead.io/lessons/cb-only",
          title: "CB only",
          pubDate: new Date("2025-06-01T00:00:00Z"),
        },
        // Older than the Rails window: not an "extra".
        {
          guid: "https://egghead.io/lessons/ancient",
          title: "Ancient",
          pubDate: new Date("2019-01-01T00:00:00Z"),
        },
      ],
    });
    expect(diff).toMatchObject({ railsItems: 3, cbItems: 3, compared: 2, matched: 1 });
    expect(diff.newerThanSnapshot.map((item) => item.guid)).toEqual([
      "https://egghead.io/lessons/newer~aaaaa",
    ]);
    expect(diff.missing.map((item) => item.guid)).toEqual([
      "https://egghead.io/lessons/missing-lesson",
    ]);
    expect(diff.extra.map((item) => item.guid)).toEqual(["https://egghead.io/lessons/cb-only"]);
    expect(diff.pubDateMismatches).toHaveLength(1);

    const report = formatParityReport(
      "lessons",
      diff,
      new Map([["https://egghead.io/lessons/missing-lesson", "slug not in the CB snapshot"]]),
      SNAPSHOT,
    );
    expect(report).toContain(
      "| https://egghead.io/lessons/missing-lesson | react: Missing lesson | 2025-02-24T22:23:03.000Z | slug not in the CB snapshot |",
    );
    expect(report).toContain("Newer than snapshot (not compared): 1");
    expect(report).not.toMatch(/@/);
  });

  it("explains misses from the CB row", () => {
    const item = { guid: "x", title: "x", pubDate: new Date("2025-01-01T00:00:00Z") };
    const base: CbSlugFacts = {
      type: "lesson",
      state: "published",
      visibilityState: "indexed",
      visibility: "public",
      deleted: false,
      hasSeriesId: false,
      feedDate: new Date("2025-01-01T00:00:00Z"),
    };
    expect(missReason(null, null, item)).toBe("slug not in the CB snapshot");
    expect(missReason({ ...base, deleted: true }, null, item)).toBe("deleted in CB");
    expect(missReason({ ...base, state: "retired" }, null, item)).toBe("CB state is retired");
    expect(missReason({ ...base, type: "course", state: "flagged" }, null, item)).toBe(
      "CB state is flagged",
    );
    expect(missReason({ ...base, visibilityState: "hidden" }, null, item)).toBe(
      "CB visibilityState is hidden",
    );
    expect(
      missReason(
        { ...base, visibilityState: "public", railsVisibilityState: "hidden" },
        null,
        item,
      ),
    ).toBe("migrated railsVisibilityState is hidden");
    // pro_feed and the course feeds are neither indexed nor without_series.
    const memberRules = { requireIndexed: false, withoutSeries: false };
    expect(missReason({ ...base, visibilityState: "hidden" }, null, item, memberRules)).toBe(
      "unexplained (CB type lesson, state published)",
    );
    expect(missReason({ ...base, hasSeriesId: true }, null, item, memberRules)).toBe(
      "unexplained (CB type lesson, state published)",
    );
    expect(missReason({ ...base, hasSeriesId: true }, null, item)).toBe(
      "CB lesson carries a Rails Series id",
    );
    expect(missReason({ ...base, visibilityState: "public" }, null, item)).toMatch(/unexplained/);
    // CB sorts by its own date; with no publishedAt that is createdAt.
    expect(
      missReason(
        { ...base, feedDate: new Date("2024-03-01T00:00:00Z") },
        new Date("2024-06-01T00:00:00Z"),
        { ...item, pubDate: new Date("2025-01-29T00:00:00Z") },
      ),
    ).toBe(
      "CB date 2024-03-01T00:00:00.000Z is older than the CB feed's item window (no CB publishedAt)",
    );
  });

  it("pairs Rails `-id` and CB `~id` slugs as slug drift, not a miss plus an extra", () => {
    const pub = new Date("2025-02-18T15:18:45Z");
    const diff = diffFeedItems({
      snapshotNewest: SNAPSHOT,
      rails: [
        {
          guid: "https://egghead.io/lessons/delete-docs-in-mongodb-vu2o7",
          title: "a",
          pubDate: pub,
        },
        { guid: "https://egghead.io/lessons/react-hooks-intro", title: "b", pubDate: pub },
      ],
      cb: [
        {
          guid: "https://egghead.io/lessons/delete-docs-in-mongo-db~vu2o7",
          title: "a",
          pubDate: pub,
        },
        // Same suffix but a different kind: not drift.
        { guid: "https://egghead.io/courses/other~vu2o7", title: "c", pubDate: pub },
      ],
    });
    expect(diff.slugDrift).toEqual([
      {
        rails: expect.objectContaining({
          guid: "https://egghead.io/lessons/delete-docs-in-mongodb-vu2o7",
        }),
        cb: expect.objectContaining({
          guid: "https://egghead.io/lessons/delete-docs-in-mongo-db~vu2o7",
        }),
        suffixId: "vu2o7",
      },
    ]);
    expect(diff.missing.map((item) => item.guid)).toEqual([
      "https://egghead.io/lessons/react-hooks-intro",
    ]);
    expect(diff.extra.map((item) => item.guid)).toEqual(["https://egghead.io/courses/other~vu2o7"]);
    // Any five base-36 characters count (judge-3 #12), digits or not.
    expect(slugSuffixId("react-hooks-intro")).toBe("intro");
    expect(slugSuffixId("foo~abcde")).toBe("abcde");
    expect(slugSuffixId("part-3")).toBeNull();
    expect(slugSuffixId("foo~cb5n2")).toBe("cb5n2");
    expect(
      formatParityReport("lessons", diff, new Map(), SNAPSHOT, { lessons: 2, playlists: 0 }),
    ).toContain("duplicate groups): lessons 2, playlists 0");
  });

  // The saved Rails feed is public content but not committed; point at it to check parsing.
  const saved = process.env["FEEDS_PARITY_RAILS_FEED"];
  it.skipIf(!saved || !existsSync(saved))("parses the saved Rails /feed", () => {
    const items = parseFeedItems(readFileSync(saved ?? "", "utf8"));
    expect(items.length).toBe(200);
    expect(items.every((item) => guidPath(item.guid) !== null && item.pubDate !== null)).toBe(true);
  });
});

describe("read-only statement guard", () => {
  it("allows reads and refuses writes and DDL", () => {
    for (const sql of [
      "SELECT 1",
      "  select 1",
      "SHOW COLUMNS FROM x",
      "WITH a AS (SELECT 1) SELECT * FROM a",
    ]) {
      expect(() => assertReadOnlyStatement(sql)).not.toThrow();
    }
    expect(() => assertReadOnlyStatement({ sql: "SELECT 1" })).not.toThrow();
    for (const sql of [
      "INSERT INTO x VALUES (1)",
      "UPDATE x SET a = 1",
      "DELETE FROM x",
      "SET autocommit = 0",
      "CREATE TABLE x (a int)",
      "",
    ]) {
      expect(() => assertReadOnlyStatement(sql)).toThrow(/read-only/);
    }
  });
});
