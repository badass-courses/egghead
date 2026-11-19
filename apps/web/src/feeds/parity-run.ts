// DB half of scripts/feeds-parity.ts (judge #9). Read-only: the caller sets
// EGGHEAD_DB_READ_ONLY before anything here opens a connection.

import type { RowDataPacket } from "mysql2";

import { contentResourceSlugSql } from "../content/resource-slug";
import {
  assertDatabaseUrlForRuntime,
  createEggheadMysqlConnection,
  getDatabaseReadOnlyMode,
} from "../db/local-docker";
import { jsonString, readPublicFeedEntries } from "./content";
import { publicFeedChannel } from "./feeds";
import {
  diffFeedItems,
  guidPath,
  missReason,
  type CbSlugFacts,
  type DuplicateCounts,
  type ParityDiff,
  type ParityItem,
} from "./parity";

type FactsRow = RowDataPacket & {
  slug: string | null;
  legacySlug: string | null;
  legacyLessonSlug: string | null;
  publishedAt: string | null;
  createdAtMs: number | string;
  type: string;
  postType: string | null;
  state: string | null;
  visibilityState: string | null;
  visibility: string | null;
  deletedAt: Date | null;
  seriesId: string | null;
};

type NewestRow = RowDataPacket & { newestMs: number | string | null };
type CountRow = RowDataPacket & { count: number | string };

/** A string field, or SQL NULL for a missing key or a JSON null. */
function json(key: string) {
  return jsonString("resource", key);
}

const LESSON_ROWS = `(resource.type = 'lesson' OR (resource.type = 'post' AND ${json("postType")} IN ('lesson', 'podcast')))`;
const PLAYLIST_ROWS = `(resource.type IN ('course', 'playlist') OR (resource.type = 'post' AND ${json("postType")} IN ('course', 'playlist')))`;

function toFacts(row: FactsRow): CbSlugFacts {
  return {
    type: row.type === "post" ? (row.postType ?? "post") : row.type,
    state: row.state,
    visibilityState: row.visibilityState,
    visibility: row.visibility,
    deleted: row.deletedAt !== null,
    hasSeriesId: row.seriesId !== null && !["0", "", "null"].includes(row.seriesId),
    feedDate: feedDate(row),
  };
}

function feedDate(row: FactsRow) {
  const published = row.publishedAt ? new Date(row.publishedAt) : null;
  if (published && !Number.isNaN(published.getTime())) return published;
  return new Date(Number(row.createdAtMs));
}

/**
 * Groups of live lesson (or playlist) rows that share one Rails id, keyed the
 * same way the feeds dedupe: the egghead id, else the legacy Rails id.
 */
function duplicateGroupsSql(idKeys: readonly [string, string], typeCondition: string) {
  const railsId = `COALESCE(${json(idKeys[0])}, ${json(idKeys[1])})`;
  return `
    SELECT COUNT(*) AS count FROM (
      SELECT ${railsId} AS railsId
      FROM egghead_ContentResource resource
      WHERE resource.deletedAt IS NULL
        AND ${typeCondition}
        AND ${railsId} IS NOT NULL
      GROUP BY railsId
      HAVING COUNT(*) > 1
    ) duplicates
  `;
}

/**
 * Rows the feed treats as indexed because CB says visibilityState "public",
 * while the migrated railsVisibilityState says Rails did not index them
 * (judge-3 #11). Non-zero means "public" is not always "indexed".
 */
const PUBLIC_BUT_RAILS_UNINDEXED_SQL = `
  SELECT COUNT(*) AS count
  FROM egghead_ContentResource resource
  WHERE resource.deletedAt IS NULL
    AND (${LESSON_ROWS} OR ${PLAYLIST_ROWS})
    AND LOWER(${json("visibilityState")}) = 'public'
    AND ${json("railsVisibilityState")} IS NOT NULL
    AND LOWER(${json("railsVisibilityState")}) <> 'indexed'
`;

export type FeedsParityResult = {
  runtime: string;
  readOnly: string;
  snapshotNewest: Date;
  diff: ParityDiff;
  reasons: Map<string, string>;
  duplicates: DuplicateCounts;
};

/** Compare the CB lessons#feed output with saved Rails items. */
export async function runLessonsFeedParity(
  rails: readonly ParityItem[],
): Promise<FeedsParityResult> {
  const readOnly = getDatabaseReadOnlyMode();
  if (!readOnly) throw new Error("Set EGGHEAD_DB_READ_ONLY before running feed parity.");
  const safety = assertDatabaseUrlForRuntime();

  const connection = await createEggheadMysqlConnection();
  try {
    const [newestRows] = await connection.query<NewestRow[]>(
      "SELECT CAST(ROUND(UNIX_TIMESTAMP(MAX(createdAt)) * 1000) AS SIGNED) AS newestMs FROM egghead_ContentResource WHERE type IN ('lesson', 'course', 'post')",
    );
    const newestValue = newestRows[0]?.newestMs;
    if (newestValue === null || newestValue === undefined) {
      throw new Error("The database has no lesson, course or post rows.");
    }
    const snapshotNewest = new Date(Number(newestValue));

    const [[lessonDupes], [playlistDupes], [publicHidden]] = await Promise.all([
      connection.query<CountRow[]>(
        duplicateGroupsSql(["eggheadLessonId", "legacyRailsLessonId"], LESSON_ROWS),
      ),
      connection.query<CountRow[]>(
        duplicateGroupsSql(["eggheadPlaylistId", "legacyRailsPlaylistId"], PLAYLIST_ROWS),
      ),
      connection.query<CountRow[]>(PUBLIC_BUT_RAILS_UNINDEXED_SQL),
    ]);
    const duplicates: DuplicateCounts = {
      lessons: Number(lessonDupes[0]?.count ?? 0),
      playlists: Number(playlistDupes[0]?.count ?? 0),
      publicButRailsUnindexed: Number(publicHidden[0]?.count ?? 0),
    };

    const cb = publicFeedChannel(await readPublicFeedEntries()).items.map(
      (item): ParityItem => ({
        guid: item.guid,
        title: item.title,
        pubDate: item.pubDate ? new Date(item.pubDate) : null,
      }),
    );
    const diff = diffFeedItems({ rails, cb, snapshotNewest });
    const cbDates = cb.flatMap((item) => (item.pubDate ? [item.pubDate.getTime()] : []));
    const cbWindowOldest = cbDates.length > 0 ? new Date(Math.min(...cbDates)) : null;

    const slugs = [
      ...new Set(
        [
          ...diff.missing,
          ...diff.extra,
          ...diff.slugDrift.flatMap((drift) => [drift.rails, drift.cb]),
        ].flatMap((item) => {
          const path = guidPath(item.guid);
          return path ? [path.slug] : [];
        }),
      ),
    ];
    const facts = new Map<string, CbSlugFacts>();
    if (slugs.length > 0) {
      const slugSql = await contentResourceSlugSql(connection, "resource");
      const inList = slugs.map(() => "?").join(", ");
      const [rows] = await connection.query<FactsRow[]>(
        `
          SELECT ${slugSql} AS slug, ${json("legacyRailsSlug")} AS legacySlug,
                 ${json("legacyRailsLessonSlug")} AS legacyLessonSlug,
                 ${json("publishedAt")} AS publishedAt,
                 CAST(ROUND(UNIX_TIMESTAMP(resource.createdAt) * 1000) AS SIGNED) AS createdAtMs,
                 resource.type, ${json("postType")} AS postType,
                 ${json("state")} AS state, ${json("visibilityState")} AS visibilityState,
                 ${json("visibility")} AS visibility, resource.deletedAt,
                 COALESCE(${json("legacyRailsSeriesId")}, ${json("eggheadSeriesId")}) AS seriesId
          FROM egghead_ContentResource resource
          WHERE (${slugSql} IN (${inList})
                 OR ${json("legacyRailsSlug")} IN (${inList})
                 OR ${json("legacyRailsLessonSlug")} IN (${inList}))
            AND resource.type IN ('lesson', 'course', 'post')
        `,
        [...slugs, ...slugs, ...slugs],
      );
      for (const row of rows) {
        for (const key of [row.slug, row.legacySlug, row.legacyLessonSlug]) {
          if (key && !facts.has(key)) facts.set(key, toFacts(row));
        }
      }
    }
    const factsFor = (guid: string) => {
      const path = guidPath(guid);
      return (path && facts.get(path.slug)) ?? null;
    };

    const reasons = new Map<string, string>();
    for (const item of diff.missing) {
      reasons.set(item.guid, missReason(factsFor(item.guid), cbWindowOldest, item));
    }
    for (const drift of diff.slugDrift) {
      reasons.set(drift.rails.guid, `slug drift: CB emits ${drift.cb.guid}`);
    }
    for (const item of diff.extra) {
      const found = factsFor(item.guid);
      reasons.set(
        item.guid,
        found
          ? `type ${found.type}, state ${found.state ?? "none"}, visibilityState ${found.visibilityState ?? "none"}`
          : "no CB row (unexpected)",
      );
    }

    return { runtime: safety.runtime, readOnly, snapshotNewest, diff, reasons, duplicates };
  } finally {
    await connection.end();
  }
}
