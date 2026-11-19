// Pure half of scripts/feeds-parity.ts (judge #9): compare the item GUIDs of
// a saved Rails feed with what the CB builder produces from a CB database.
//
// A database snapshot only knows content created before it was taken, so
// Rails items newer than the snapshot's newest content row are reported in
// their own bucket instead of as misses.

import { child, childText, children, parseXml } from "./xml-test-parser";

export type ParityItem = {
  guid: string;
  title: string;
  pubDate: Date | null;
};

function parseDate(value: string | undefined) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Items of an RSS document (Rails or CB output), in document order. */
export function parseFeedItems(xml: string): ParityItem[] {
  const channel = child(parseXml(xml), "channel");
  if (!channel) throw new Error("Not an RSS document: no <channel>.");
  return children(channel, "item").flatMap((item) => {
    const guid = childText(item, "guid")?.trim();
    if (!guid) return [];
    return [
      {
        guid,
        title: childText(item, "title")?.trim() ?? "",
        pubDate: parseDate(childText(item, "pubDate")),
      },
    ];
  });
}

/** `https://egghead.io/lessons/foo~ab12c` -> { kind: "lessons", slug: "foo~ab12c" } */
export function guidPath(guid: string): { kind: string; slug: string } | null {
  const match = /^https:\/\/egghead\.io\/([a-z]+)\/([^/?#]+)$/.exec(guid);
  return match?.[1] && match[2] ? { kind: match[1], slug: decodeURIComponent(match[2]) } : null;
}

/**
 * The short id at the end of a slug: Rails `foo-vu2o7` and CB `foo~vu2o7`
 * share `vu2o7`. Any five lowercase letters or digits: CB ids are base-36,
 * and about a fifth of them have no digit. A trailing five-letter word can
 * pair wrongly, which is acceptable for a report that also prints both GUIDs.
 */
export function slugSuffixId(slug: string): string | null {
  const match = /[-~]([a-z0-9]{5})$/.exec(slug);
  const id = match?.[1];
  return id ?? null;
}

export type SlugDrift = { rails: ParityItem; cb: ParityItem; suffixId: string };

export type ParityDiff = {
  railsItems: number;
  cbItems: number;
  /** Rails items the snapshot could know about. */
  compared: number;
  matched: number;
  /** Rails items (within the snapshot) missing from CB output. */
  missing: ParityItem[];
  /** CB items, inside the Rails feed's date range, missing from Rails. */
  extra: ParityItem[];
  /** Rails items published after the snapshot's newest content row. */
  newerThanSnapshot: ParityItem[];
  /** Same item (kind and suffix id) under a different slug: readers see a new GUID. */
  slugDrift: SlugDrift[];
  /** Matched GUIDs whose pubDate instants differ. */
  pubDateMismatches: Array<{ guid: string; rails: Date | null; cb: Date | null }>;
};

export function diffFeedItems(input: {
  rails: readonly ParityItem[];
  cb: readonly ParityItem[];
  snapshotNewest: Date;
}): ParityDiff {
  const newerThanSnapshot = input.rails.filter(
    (item) => item.pubDate !== null && item.pubDate > input.snapshotNewest,
  );
  const inScope = input.rails.filter((item) => !newerThanSnapshot.includes(item));
  const cbByGuid = new Map(input.cb.map((item) => [item.guid, item]));
  const railsGuids = new Set(input.rails.map((item) => item.guid));

  const dated = inScope.flatMap((item) => (item.pubDate ? [item.pubDate.getTime()] : []));
  const oldestRails = dated.length > 0 ? Math.min(...dated) : Number.NEGATIVE_INFINITY;
  const extra = input.cb.filter(
    (item) =>
      !railsGuids.has(item.guid) &&
      (item.pubDate === null || item.pubDate.getTime() >= oldestRails),
  );

  const missing: ParityItem[] = [];
  const pubDateMismatches: ParityDiff["pubDateMismatches"] = [];
  for (const item of inScope) {
    const cb = cbByGuid.get(item.guid);
    if (!cb) {
      missing.push(item);
      continue;
    }
    if ((item.pubDate?.getTime() ?? null) !== (cb.pubDate?.getTime() ?? null)) {
      pubDateMismatches.push({ guid: item.guid, rails: item.pubDate, cb: cb.pubDate });
    }
  }

  // Pair a missing Rails item with an extra CB item of the same kind and
  // suffix id, when that pairing is unique on both sides.
  const driftKey = (item: ParityItem) => {
    const path = guidPath(item.guid);
    const id = path ? slugSuffixId(path.slug) : null;
    return path && id ? `${path.kind}:${id}` : null;
  };
  const extraByKey = new Map<string, ParityItem[]>();
  for (const item of extra) {
    const key = driftKey(item);
    if (key) extraByKey.set(key, [...(extraByKey.get(key) ?? []), item]);
  }
  const missingKeys = missing.map(driftKey);
  const slugDrift: SlugDrift[] = [];
  for (const [index, item] of missing.entries()) {
    const key = missingKeys[index];
    if (!key) continue;
    const candidates = extraByKey.get(key) ?? [];
    const sameKeyMissing = missingKeys.filter((other) => other === key).length;
    const [cb] = candidates;
    if (cb && candidates.length === 1 && sameKeyMissing === 1) {
      slugDrift.push({ rails: item, cb, suffixId: key.split(":")[1] ?? "" });
    }
  }
  const driftRails = new Set(slugDrift.map((drift) => drift.rails));
  const driftCb = new Set(slugDrift.map((drift) => drift.cb));

  return {
    railsItems: input.rails.length,
    cbItems: input.cb.length,
    compared: inScope.length,
    matched: inScope.length - missing.length,
    missing: missing.filter((item) => !driftRails.has(item)),
    extra: extra.filter((item) => !driftCb.has(item)),
    newerThanSnapshot,
    slugDrift,
    pubDateMismatches,
  };
}

/** What the CB snapshot holds for a slug, as far as the miss reason needs. */
export type CbSlugFacts = {
  type: string;
  state: string | null;
  visibilityState: string | null;
  visibility: string | null;
  deleted: boolean;
  hasSeriesId: boolean;
  /** The date the CB feed sorts by: fields.publishedAt, else createdAt. */
  feedDate: Date | null;
};

const LESSON_STATES = new Set(["published", "flagged", "revised"]);

/** Why a Rails item is missing from CB output, in plain words. */
export function missReason(
  facts: CbSlugFacts | null,
  cbWindowOldest: Date | null,
  rails: ParityItem,
) {
  if (!facts) return "slug not in the CB snapshot";
  if (facts.deleted) return "deleted in CB";
  const state = (facts.state ?? "published").toLowerCase();
  const isCourse = facts.type === "course";
  if (isCourse ? state !== "published" : !LESSON_STATES.has(state)) return `CB state is ${state}`;
  const visibilityState = (facts.visibilityState ?? "indexed").toLowerCase();
  if (visibilityState !== "indexed" && visibilityState !== "public") {
    return `CB visibilityState is ${visibilityState}`;
  }
  const visibility = (facts.visibility ?? "public").toLowerCase();
  if (visibility !== "public") return `CB visibility is ${visibility}`;
  if (facts.hasSeriesId) return "CB lesson carries a Rails Series id";
  if (cbWindowOldest && facts.feedDate && facts.feedDate < cbWindowOldest) {
    return `CB date ${facts.feedDate.toISOString()} is older than the CB feed's 200-item window (no CB publishedAt)`;
  }
  if (cbWindowOldest && rails.pubDate && rails.pubDate < cbWindowOldest) {
    return "older than the CB feed's 200-item window";
  }
  return `unexplained (CB type ${facts.type}, state ${state})`;
}

function cell(value: string) {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function iso(date: Date | null) {
  return date ? date.toISOString() : "none";
}

/** Plain-text report: counts, the miss table, extras and the newer bucket. No emails. */
export type DuplicateCounts = {
  lessons: number;
  playlists: number;
  /** CB visibilityState "public" rows whose railsVisibilityState is not indexed. */
  publicButRailsUnindexed?: number;
};

export function formatParityReport(
  feed: string,
  diff: ParityDiff,
  reasons: ReadonlyMap<string, string>,
  snapshotNewest: Date,
  duplicates?: DuplicateCounts,
) {
  const lines = [
    `# Feed parity: ${feed}`,
    "",
    `Snapshot newest content row: ${snapshotNewest.toISOString()}`,
    `Rails items: ${diff.railsItems}; CB items: ${diff.cbItems}`,
    `Compared (Rails items inside the snapshot): ${diff.compared}`,
    `Matched GUIDs: ${diff.matched}; missing from CB: ${diff.missing.length}; extra in CB: ${diff.extra.length}`,
    `Slug drift (same item, different GUID): ${diff.slugDrift.length}`,
    `Newer than snapshot (not compared): ${diff.newerThanSnapshot.length}`,
    ...(duplicates
      ? [
          `CB rows sharing a Rails id (duplicate groups): lessons ${duplicates.lessons}, playlists ${duplicates.playlists}`,
          ...(duplicates.publicButRailsUnindexed === undefined
            ? []
            : [
                `visibilityState "public" but Rails not indexed: ${duplicates.publicButRailsUnindexed}`,
              ]),
        ]
      : []),
    `pubDate differences on matched GUIDs: ${diff.pubDateMismatches.length}`,
    "",
    "## Missing from CB",
    "",
    "| GUID | Title | Rails pubDate | Reason |",
    "| --- | --- | --- | --- |",
    ...diff.missing.map(
      (item) =>
        `| ${cell(item.guid)} | ${cell(item.title)} | ${iso(item.pubDate)} | ${cell(reasons.get(item.guid) ?? "")} |`,
    ),
    "",
    "## Slug drift",
    "",
    "| Rails GUID | CB GUID | Suffix id |",
    "| --- | --- | --- |",
    ...diff.slugDrift.map(
      (drift) => `| ${cell(drift.rails.guid)} | ${cell(drift.cb.guid)} | ${drift.suffixId} |`,
    ),
    "",
    "## Extra in CB (inside the Rails date range)",
    "",
    "| GUID | Title | CB pubDate | CB facts |",
    "| --- | --- | --- | --- |",
    ...diff.extra.map(
      (item) =>
        `| ${cell(item.guid)} | ${cell(item.title)} | ${iso(item.pubDate)} | ${cell(reasons.get(item.guid) ?? "")} |`,
    ),
    "",
    "## Newer than snapshot (not in snapshot)",
    "",
    "| GUID | Rails pubDate |",
    "| --- | --- |",
    ...diff.newerThanSnapshot.map((item) => `| ${cell(item.guid)} | ${iso(item.pubDate)} |`),
    "",
    "## pubDate differences (first 20)",
    "",
    "| GUID | Rails | CB |",
    "| --- | --- | --- |",
    ...diff.pubDateMismatches
      .slice(0, 20)
      .map((row) => `| ${cell(row.guid)} | ${iso(row.rails)} | ${iso(row.cb)} |`),
  ];
  return `${lines.join("\n")}\n`;
}
