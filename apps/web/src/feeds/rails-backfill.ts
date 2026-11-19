// Pure half of the desk-run Rails backfill (scripts/backfill-feed-rails-fields.ts).
//
// CB posts never kept the Rails publish time (the builder wrote it only to
// Rails) and some CB slugs differ from the Rails slug. The feeds need both to
// keep Rails pubDates and GUIDs. This backfill copies them from a Rails export
// into CB fields, matched by Rails id:
// - `publishedAt` (ISO 8601 UTC) when the CB row has none;
// - `legacyRailsSlug` when the Rails slug differs from the CB slug and the
//   CB row has no Rails slug yet.
// It only ever adds missing keys. A CB value that disagrees with Rails is
// reported as a conflict and left alone.

/**
 * Run in psql against egghead-rails:
 *   \copy (<this>) TO 'rails-feed-fields.csv' WITH CSV HEADER
 * Time zone (judge-3 #8): lessons.published_at and playlists.published_at are
 * `timestamp without time zone` holding UTC (no default_timezone override;
 * the desk confirmed the column type and a UTC server). to_char on that type
 * prints the stored value as is, whatever the psql session TimeZone, so the
 * literal "Z" is right. Do not add AT TIME ZONE 'UTC' here: on a timestamp
 * without time zone it converts to timestamptz and to_char would then print in
 * the session zone. If the column ever becomes timestamptz, use
 * to_char(published_at AT TIME ZONE 'UTC', ...) instead.
 * Slugs are friendly_id slugs, never quoted.
 */
export const RAILS_FEED_FIELDS_EXPORT_SQL =
  "SELECT 'lesson' AS kind, id AS rails_id, slug, " +
  'to_char(published_at, \'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS published_at ' +
  "FROM lessons WHERE slug IS NOT NULL " +
  "UNION ALL " +
  "SELECT 'playlist' AS kind, id AS rails_id, slug, " +
  'to_char(published_at, \'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS published_at ' +
  // Rails holds over a million user playlists; only published ones are feed content.
  "FROM playlists WHERE slug IS NOT NULL AND published_at IS NOT NULL " +
  "ORDER BY 1, 2";

export const RAILS_FEED_FIELDS_HEADER = "kind,rails_id,slug,published_at";

export type RailsKind = "lesson" | "playlist";

export type RailsFeedFieldsRow = {
  kind: RailsKind;
  railsId: string;
  slug: string;
  publishedAt: string | null;
};

const RAILS_ID = /^[1-9]\d*$/;
const SLUG = /^[a-z0-9~_-]+$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function parseRailsFeedFieldsExport(csv: string) {
  const rows: RailsFeedFieldsRow[] = [];
  const rejected: Array<{ line: number; reason: string }> = [];
  const seen = new Set<string>();
  for (const [index, raw] of csv.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    if (index === 0 && line.toLowerCase() === RAILS_FEED_FIELDS_HEADER) continue;
    const [kind = "", railsId = "", slug = "", publishedAt = "", ...extra] = line
      .split(",")
      .map((cell) => cell.trim());
    const reason =
      extra.length > 0
        ? "extra_columns"
        : kind !== "lesson" && kind !== "playlist"
          ? "bad_kind"
          : !RAILS_ID.test(railsId)
            ? "bad_rails_id"
            : !SLUG.test(slug)
              ? "bad_slug"
              : publishedAt && !ISO_UTC.test(publishedAt)
                ? "bad_published_at"
                : seen.has(`${kind}:${railsId}`)
                  ? "duplicate"
                  : null;
    if (reason || (kind !== "lesson" && kind !== "playlist")) {
      rejected.push({ line: index + 1, reason: reason ?? "bad_kind" });
      continue;
    }
    seen.add(`${kind}:${railsId}`);
    rows.push({ kind, railsId, slug, publishedAt: publishedAt || null });
  }
  return { rows, rejected };
}

/** What the backfill needs from one CB row. */
export type CbBackfillRow = {
  id: string;
  kind: RailsKind;
  railsId: string;
  slug: string | null;
  publishedAt: string | null;
  railsSlug: string | null;
};

export type BackfillUpdate = {
  id: string;
  set: { publishedAt?: string; legacyRailsSlug?: string };
  /**
   * Values this update replaces (only with fixPacificShift). A key absent
   * here was missing before; rollback removes it. A key present here is
   * restored to this value.
   */
  previous?: { publishedAt?: string };
};

/** A CB value that disagrees with Rails. Public content only: ids, slugs, dates. */
export type BackfillConflict = {
  field: "publishedAt" | "slug";
  kind: RailsKind;
  railsId: string;
  cbId: string;
  cb: string;
  rails: string;
};

export type BackfillPlan = {
  cbRows: number;
  matched: number;
  unmatched: number;
  updates: BackfillUpdate[];
  setPublishedAt: number;
  setLegacyRailsSlug: number;
  publishedAtConflicts: number;
  slugConflicts: number;
  /** publishedAt conflicts where Rails holds the later date. */
  railsDateNewer: number;
  /** publishedAt conflicts where CB holds the later date. */
  cbDateNewer: number;
  /** Rows whose CB publishedAt already equals Rails, to the millisecond. */
  publishedAtEqual: number;
  /** Conflicts where CB = Rails + the Los Angeles UTC offset at the Rails instant. */
  pacificShifted: number;
  /** Every other publishedAt conflict; never overwritten. */
  otherDateConflicts: number;
  /** pacificShifted conflicts this plan overwrites (fixPacificShift only). */
  fixedPacificShift: number;
  conflicts: BackfillConflict[];
};

const LOS_ANGELES = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Los Angeles's UTC offset at an instant, in ms (8h standard, 7h daylight). */
export function losAngelesOffsetMs(instant: Date) {
  const parts = Object.fromEntries(
    LOS_ANGELES.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  const wall = Date.UTC(
    Number(parts["year"]),
    Number(parts["month"]) - 1,
    Number(parts["day"]),
    Number(parts["hour"]),
    Number(parts["minute"]),
    Number(parts["second"]),
  );
  const seconds = Math.floor(instant.getTime() / 1000) * 1000;
  return seconds - wall;
}

/**
 * The migration read Rails' UTC published_at as Pacific wall time, so the CB
 * value is the Rails instant plus the Los Angeles offset (beta: all 78
 * conflicts are exactly +7h or +8h).
 */
export function isPacificShift(cbPublishedAt: string, railsPublishedAt: string) {
  const cb = new Date(cbPublishedAt).getTime();
  const rails = new Date(railsPublishedAt);
  if (Number.isNaN(cb) || Number.isNaN(rails.getTime())) return false;
  return cb - rails.getTime() === losAngelesOffsetMs(rails);
}

function sameInstant(a: string, b: string) {
  const left = new Date(a).getTime();
  const right = new Date(b).getTime();
  return !Number.isNaN(left) && left === right;
}

/**
 * fixPacificShift: overwrite a CB publishedAt with Rails only when CB is the
 * Rails instant shifted by the Los Angeles offset (the migration bug). Every
 * other conflict is counted and left alone.
 */
export function planRailsBackfill(
  cbRows: readonly CbBackfillRow[],
  railsRows: readonly RailsFeedFieldsRow[],
  options: { fixPacificShift?: boolean } = {},
): BackfillPlan {
  const rails = new Map(railsRows.map((row) => [`${row.kind}:${row.railsId}`, row]));
  const plan: BackfillPlan = {
    cbRows: cbRows.length,
    matched: 0,
    unmatched: 0,
    updates: [],
    setPublishedAt: 0,
    setLegacyRailsSlug: 0,
    publishedAtConflicts: 0,
    slugConflicts: 0,
    railsDateNewer: 0,
    cbDateNewer: 0,
    publishedAtEqual: 0,
    pacificShifted: 0,
    otherDateConflicts: 0,
    fixedPacificShift: 0,
    conflicts: [],
  };

  for (const cb of cbRows) {
    const source = rails.get(`${cb.kind}:${cb.railsId}`);
    if (!source) {
      plan.unmatched += 1;
      continue;
    }
    plan.matched += 1;
    const set: BackfillUpdate["set"] = {};
    const previous: { publishedAt?: string } = {};

    if (source.publishedAt) {
      if (!cb.publishedAt) set.publishedAt = source.publishedAt;
      else if (sameInstant(cb.publishedAt, source.publishedAt)) plan.publishedAtEqual += 1;
      else {
        plan.publishedAtConflicts += 1;
        if (new Date(source.publishedAt).getTime() > new Date(cb.publishedAt).getTime()) {
          plan.railsDateNewer += 1;
        } else {
          plan.cbDateNewer += 1;
        }
        if (isPacificShift(cb.publishedAt, source.publishedAt)) {
          plan.pacificShifted += 1;
          if (options.fixPacificShift) {
            set.publishedAt = source.publishedAt;
            previous.publishedAt = cb.publishedAt;
            plan.fixedPacificShift += 1;
          }
        } else {
          plan.otherDateConflicts += 1;
        }
        plan.conflicts.push({
          field: "publishedAt",
          kind: cb.kind,
          railsId: cb.railsId,
          cbId: cb.id,
          cb: cb.publishedAt,
          rails: source.publishedAt,
        });
      }
    }
    if (source.slug !== cb.slug) {
      if (!cb.railsSlug) set.legacyRailsSlug = source.slug;
      else if (cb.railsSlug !== source.slug) {
        plan.slugConflicts += 1;
        plan.conflicts.push({
          field: "slug",
          kind: cb.kind,
          railsId: cb.railsId,
          cbId: cb.id,
          cb: cb.railsSlug,
          rails: source.slug,
        });
      }
    }

    if (set.publishedAt && !previous.publishedAt) plan.setPublishedAt += 1;
    if (set.legacyRailsSlug) plan.setLegacyRailsSlug += 1;
    if (set.publishedAt || set.legacyRailsSlug) {
      plan.updates.push(previous.publishedAt ? { id: cb.id, set, previous } : { id: cb.id, set });
    }
  }
  return plan;
}
