import { describe, expect, it } from "vitest";

import {
  isPacificShift,
  losAngelesOffsetMs,
  parseRailsFeedFieldsExport,
  planRailsBackfill,
  RAILS_FEED_FIELDS_EXPORT_SQL,
  type CbBackfillRow,
} from "./rails-backfill";

function row(id: string, railsId: string, publishedAt: string): CbBackfillRow {
  return { id, kind: "lesson", railsId, slug: id, publishedAt, railsSlug: null };
}

describe("Rails feed-fields backfill (pure)", () => {
  it("exports UTC ISO publish times for lessons and playlists", () => {
    expect(RAILS_FEED_FIELDS_EXPORT_SQL).toContain("FROM lessons");
    expect(RAILS_FEED_FIELDS_EXPORT_SQL).toContain(
      "FROM playlists WHERE slug IS NOT NULL AND published_at IS NOT NULL",
    );
    expect(RAILS_FEED_FIELDS_EXPORT_SQL).toContain(`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`);
  });

  it("parses rows and rejects bad ones", () => {
    const { rows, rejected } = parseRailsFeedFieldsExport(
      [
        "kind,rails_id,slug,published_at",
        "lesson,101,fixture-mongodb-docs-vu2o7,2025-02-18T15:18:45.000Z",
        "playlist,9001,fixture-course,",
        "series,5,x,",
        "lesson,abc,x,",
        "lesson,102,bad slug,",
        "lesson,103,ok,2025-02-18 15:18:45",
        "lesson,101,again,",
        "lesson,104,ok,,extra",
      ].join("\n"),
    );
    expect(rows).toEqual([
      {
        kind: "lesson",
        railsId: "101",
        slug: "fixture-mongodb-docs-vu2o7",
        publishedAt: "2025-02-18T15:18:45.000Z",
      },
      { kind: "playlist", railsId: "9001", slug: "fixture-course", publishedAt: null },
    ]);
    expect(rejected.map((entry) => entry.reason)).toEqual([
      "bad_kind",
      "bad_rails_id",
      "bad_slug",
      "bad_published_at",
      "duplicate",
      "extra_columns",
    ]);
  });

  it("knows the Los Angeles offset, including DST", () => {
    expect(losAngelesOffsetMs(new Date("2025-01-18T15:18:45.000Z"))).toBe(8 * 3_600_000);
    expect(losAngelesOffsetMs(new Date("2025-07-01T12:00:00.000Z"))).toBe(7 * 3_600_000);
    // DST started 2025-03-09 at 10:00 UTC.
    expect(losAngelesOffsetMs(new Date("2025-03-09T09:59:59.000Z"))).toBe(8 * 3_600_000);
    expect(losAngelesOffsetMs(new Date("2025-03-09T10:00:00.000Z"))).toBe(7 * 3_600_000);
    expect(isPacificShift("2025-01-18T23:18:45.000Z", "2025-01-18T15:18:45.000Z")).toBe(true);
    expect(isPacificShift("2025-07-01T19:00:00.000Z", "2025-07-01T12:00:00.000Z")).toBe(true);
    // 8h in summer is not the shift; one millisecond off is not either.
    expect(isPacificShift("2025-07-01T20:00:00.000Z", "2025-07-01T12:00:00.000Z")).toBe(false);
    expect(isPacificShift("2025-01-18T23:18:45.001Z", "2025-01-18T15:18:45.000Z")).toBe(false);
  });

  it("fixPacificShift overwrites only shifted dates, records the old value, counts the rest", () => {
    const cb = [
      row("shift8", "1", "2025-01-18T23:18:45.000Z"),
      row("shift7", "2", "2025-07-01T19:00:00.000Z"),
      row("other", "3", "2024-01-01T00:00:00.000Z"),
      row("equal", "4", "2023-05-05T05:05:05Z"),
    ];
    const rails = [
      {
        kind: "lesson" as const,
        railsId: "1",
        slug: "shift8",
        publishedAt: "2025-01-18T15:18:45.000Z",
      },
      {
        kind: "lesson" as const,
        railsId: "2",
        slug: "shift7",
        publishedAt: "2025-07-01T12:00:00.000Z",
      },
      {
        kind: "lesson" as const,
        railsId: "3",
        slug: "other",
        publishedAt: "2023-01-01T00:00:00.000Z",
      },
      {
        kind: "lesson" as const,
        railsId: "4",
        slug: "equal",
        publishedAt: "2023-05-05T05:05:05.000Z",
      },
    ];
    const counts = {
      publishedAtConflicts: 3,
      publishedAtEqual: 1,
      pacificShifted: 2,
      otherDateConflicts: 1,
      cbDateNewer: 3,
      railsDateNewer: 0,
    };
    const report = planRailsBackfill(cb, rails);
    expect(report.updates).toEqual([]);
    expect(report).toMatchObject({ ...counts, fixedPacificShift: 0 });

    const plan = planRailsBackfill(cb, rails, { fixPacificShift: true });
    expect(plan.updates).toEqual([
      {
        id: "shift8",
        set: { publishedAt: "2025-01-18T15:18:45.000Z" },
        previous: { publishedAt: "2025-01-18T23:18:45.000Z" },
      },
      {
        id: "shift7",
        set: { publishedAt: "2025-07-01T12:00:00.000Z" },
        previous: { publishedAt: "2025-07-01T19:00:00.000Z" },
      },
    ]);
    expect(plan).toMatchObject({ ...counts, fixedPacificShift: 2, setPublishedAt: 0 });
  });

  it("adds only missing keys and reports disagreements as conflicts", () => {
    const cb: CbBackfillRow[] = [
      // CB-native post: new slug, no publish date.
      {
        id: "post_a",
        kind: "lesson",
        railsId: "101",
        slug: "new~vu2o7",
        publishedAt: null,
        railsSlug: null,
      },
      // Migrated row: already right.
      {
        id: "eh_a",
        kind: "lesson",
        railsId: "101",
        slug: "old-vu2o7",
        publishedAt: "2025-02-18T15:18:45Z",
        railsSlug: "old-vu2o7",
      },
      // Disagrees with Rails on both: left alone.
      {
        id: "post_b",
        kind: "lesson",
        railsId: "102",
        slug: "b~1",
        publishedAt: "2020-01-01T00:00:00.000Z",
        railsSlug: "something-else",
      },
      {
        id: "c1",
        kind: "playlist",
        railsId: "9001",
        slug: "course",
        publishedAt: null,
        railsSlug: null,
      },
      {
        id: "orphan",
        kind: "lesson",
        railsId: "999",
        slug: "x",
        publishedAt: null,
        railsSlug: null,
      },
    ];
    const plan = planRailsBackfill(cb, [
      {
        kind: "lesson",
        railsId: "101",
        slug: "old-vu2o7",
        publishedAt: "2025-02-18T15:18:45.000Z",
      },
      { kind: "lesson", railsId: "102", slug: "b-rails", publishedAt: "2021-01-01T00:00:00.000Z" },
      {
        kind: "playlist",
        railsId: "9001",
        slug: "course",
        publishedAt: "2024-04-10T15:30:00.000Z",
      },
    ]);
    expect(plan.updates).toEqual([
      {
        id: "post_a",
        set: { publishedAt: "2025-02-18T15:18:45.000Z", legacyRailsSlug: "old-vu2o7" },
      },
      { id: "c1", set: { publishedAt: "2024-04-10T15:30:00.000Z" } },
    ]);
    expect(plan).toMatchObject({
      cbRows: 5,
      matched: 4,
      unmatched: 1,
      setPublishedAt: 2,
      setLegacyRailsSlug: 1,
      publishedAtConflicts: 1,
      slugConflicts: 1,
      railsDateNewer: 1,
      cbDateNewer: 0,
    });
    expect(plan.conflicts).toEqual([
      {
        field: "publishedAt",
        kind: "lesson",
        railsId: "102",
        cbId: "post_b",
        cb: "2020-01-01T00:00:00.000Z",
        rails: "2021-01-01T00:00:00.000Z",
      },
      {
        field: "slug",
        kind: "lesson",
        railsId: "102",
        cbId: "post_b",
        cb: "something-else",
        rails: "b-rails",
      },
    ]);
  });
});
