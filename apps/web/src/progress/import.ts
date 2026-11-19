import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { Connection } from "mysql2/promise";
import { randomUUID } from "node:crypto";

import {
  type CbContentCatalog,
  loadCbContentCatalog,
  normalizeSlug,
  positiveInteger,
} from "./import-catalog";
import { normalizeEmail, type RailsProgressSource, type RailsUserProgress } from "./import-source";

/**
 * Rails → CourseBuilder progress import.
 *
 * Rails completions become `egghead_ResourceProgress` rows, the same table the
 * lesson player writes. Lesson completions land on the CB lesson row; Rails
 * series (playlist) completions land on the CB course row.
 *
 * Write rules, per (CB user, resource):
 * - no CB row: insert a completed row stamped with the Rails completion time.
 * - CB row already completed: keep it. CB wins, so re-runs are no-ops.
 * - CB row explicitly un-completed by the learner (see
 *   `EXPLICIT_UNCOMPLETE_SOURCES`) at or after the Rails completion: keep it.
 * - CB row whose `fields` is not a JSON object: leave it, counted on its own.
 * - any other CB row with a null `completedAt`: mark it completed with the
 *   Rails time, keeping its `source` and recording the prior state.
 *
 * Every written row gets `updatedAt = at` and `fields.railsImport`:
 * `{runId, at, action, railsUserId, rails, completedAt}`, plus
 * `prior: {fields, updatedAt}` on updates, copied server-side so the prior JSON
 * is never round-tripped through JavaScript. `import-rollback.ts` undoes a run
 * from those stamps.
 *
 * The real table (`@coursebuilder/adapter-drizzle` `ResourceProgress`) uses
 * `DATETIME(3)` with no `ON UPDATE`, so every timestamp here travels as a UTC
 * string and the session must be UTC: `assertUtcSession` refuses anything else.
 */

export const PROGRESS_IMPORT_SOURCE = "rails_progress_import";
export const DEFAULT_PROGRESS_IMPORT_BATCH_SIZE = 500;
/** Upper bound on rows written in one transaction, to keep locks and PlanetScale transactions short. */
export const MAX_ROWS_PER_TRANSACTION = 5000;
const WRITE_CHUNK_SIZE = 500;
const SAMPLE_LIMIT = 10;
const UNMAPPED_LESSON_SAMPLE_LIMIT = 25;

export type ProgressImportDb = Pick<
  Connection,
  "execute" | "query" | "beginTransaction" | "commit" | "rollback"
>;

/**
 * Sources `uncompleteResourceForUser` stamps when a learner un-completes a
 * lesson (`setLessonCompletion`). They are the only writers that leave a lesson
 * row with a null `completedAt`. `syncCourseProgressForUser` also nulls course
 * rows, as `course_lessons_incomplete`, but that is an automatic recount, not a
 * learner decision, so it does not outrank a Rails completion.
 */
export const EXPLICIT_UNCOMPLETE_SOURCES: readonly string[] = [
  "lesson_progress_control",
  "lesson_player_ended",
];

export function newProgressImportRunId(now = new Date()) {
  return `rails-import-${now.toISOString()}-${randomUUID().slice(0, 8)}`;
}

/** `YYYY-MM-DD HH:MM:SS.mmm` in UTC, the form MySQL compares exactly on a UTC session. */
export function mysqlUtcDateTime(date: Date) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

type UtcProbeRow = RowDataPacket & { offsetSeconds: number | string; probe: Date | string };

/**
 * Both the server session and mysql2's Date handling must be UTC, or stamps and
 * the exact `updatedAt` guards shift by the zone offset. `openUtcConnection`
 * gives such a connection; the app's own pool does not.
 */
export async function assertUtcSession(db: Pick<Connection, "query">) {
  const [rows] = await db.query<UtcProbeRow[]>(
    "SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) AS offsetSeconds, CAST('2000-01-01 00:00:00' AS DATETIME) AS probe",
  );
  const row = rows[0];
  const serverUtc = Number(row?.offsetSeconds) === 0;
  const clientUtc = row?.probe instanceof Date && row.probe.getTime() === Date.UTC(2000, 0, 1);
  if (!serverUtc || !clientUtc) {
    throw new Error(
      `Progress import needs a UTC session (server offset ${String(row?.offsetSeconds)}s, client UTC ${String(clientUtc)}). Open it with openUtcConnection.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Users: Rails user id → CB user id.

export type UserMatch =
  | { status: "matched"; cbUserId: string; matchedBy: "legacy_rails_user_id" | "email" }
  | { status: "unmatched"; reason: "no_cb_user" | "email_conflict" | "email_shared" };

type CbUserRow = RowDataPacket & {
  id: string;
  email: string;
  legacyRailsUserId: string | null;
};

function placeholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ");
}

/**
 * Matches by the stored `User.legacyRailsUserId` first. Falls back to the
 * normalized email, with two refusals that are never written:
 * - `email_conflict`: that CB user already belongs to a different Rails id.
 * - `email_shared`: a lower Rails id carries the same normalized email
 *   (`emailOwners`), so only that one may claim the CB user by email.
 */
export async function matchCbUsers(
  db: Pick<Connection, "execute">,
  users: readonly RailsUserProgress[],
  emailOwners?: ReadonlyMap<string, number>,
): Promise<Map<number, UserMatch>> {
  const matches = new Map<number, UserMatch>();
  if (users.length === 0) return matches;

  const railsIds = users.map((user) => String(user.railsUserId));
  const [byLegacyRows] = await db.execute<CbUserRow[]>(
    `
      SELECT id, email, legacyRailsUserId
      FROM egghead_User
      WHERE legacyRailsUserId IN (${placeholders(railsIds.length)})
    `,
    railsIds,
  );
  const byLegacyId = new Map(byLegacyRows.map((row) => [String(row.legacyRailsUserId), row.id]));

  const remaining = users.filter((user) => !byLegacyId.has(String(user.railsUserId)));
  const emails = [
    ...new Set(
      remaining.map((user) => normalizeEmail(user.email)).filter((email) => email !== null),
    ),
  ];
  const byEmail = new Map<string, CbUserRow>();

  if (emails.length > 0) {
    // `email` uses the database's case-insensitive default collation, so this
    // matches the lower-cased export and still uses the unique index.
    const [byEmailRows] = await db.execute<CbUserRow[]>(
      `
        SELECT id, email, legacyRailsUserId
        FROM egghead_User
        WHERE email IN (${placeholders(emails.length)})
      `,
      emails,
    );
    for (const row of byEmailRows) {
      const email = normalizeEmail(row.email);
      if (email !== null) byEmail.set(email, row);
    }
  }

  for (const user of users) {
    const legacyMatch = byLegacyId.get(String(user.railsUserId));
    if (legacyMatch) {
      matches.set(user.railsUserId, {
        status: "matched",
        cbUserId: legacyMatch,
        matchedBy: "legacy_rails_user_id",
      });
      continue;
    }

    const email = normalizeEmail(user.email);
    const emailMatch = email === null ? undefined : byEmail.get(email);
    if (!emailMatch || email === null) {
      matches.set(user.railsUserId, { status: "unmatched", reason: "no_cb_user" });
      continue;
    }

    const claimedRailsId = positiveInteger(emailMatch.legacyRailsUserId);
    if (claimedRailsId !== null && claimedRailsId !== user.railsUserId) {
      matches.set(user.railsUserId, { status: "unmatched", reason: "email_conflict" });
      continue;
    }

    const owner = emailOwners?.get(email);
    if (owner !== undefined && owner !== user.railsUserId) {
      matches.set(user.railsUserId, { status: "unmatched", reason: "email_shared" });
      continue;
    }

    matches.set(user.railsUserId, {
      status: "matched",
      cbUserId: emailMatch.id,
      matchedBy: "email",
    });
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Planning and writing.

export type ProgressImportReceipt = {
  mode: "dry_run" | "apply";
  /** Stamped into every written row as `fields.railsImport.runId`; rollback takes it. */
  runId: string;
  source: string;
  startedAt: string;
  finishedAt: string | null;
  afterRailsUserId: number;
  maxUsers: number | null;
  /** True when the run read the whole source: no `afterRailsUserId`, no `maxUsers`, finished. */
  fullSource: boolean;
  lastRailsUserId: number | null;
  batches: number;
  transactions: number;
  catalog: CbContentCatalog["stats"];
  users: {
    seen: number;
    matchedByLegacyRailsUserId: number;
    matchedByEmail: number;
    unmatchedNoCbUser: number;
    unmatchedEmailConflict: number;
    /** A lower Rails id carries the same normalized email and owns the email match. */
    unmatchedSharedEmail: number;
    /** Per-user path only: the Rails user resolves to a different CB user. */
    matchedOtherCbUser: number;
  };
  lessons: {
    seen: number;
    mappedByRailsId: number;
    mappedBySlug: number;
    unmapped: number;
    distinctUnmappedRailsLessonIds: number;
    skippedForUnmatchedUser: number;
  };
  series: {
    seen: number;
    mappedByRailsPlaylistId: number;
    mappedBySlug: number;
    unmapped: number;
    skippedForUnmatchedUser: number;
  };
  rows: {
    toInsert: number;
    toUpdate: number;
    keptCbCompleted: number;
    /** The learner explicitly un-completed the resource on CB after the Rails completion. */
    keptCbNewer: number;
    /** The CB row's `fields` is a JSON array or scalar; left alone. */
    keptFieldsNotObject: number;
    /** Two Rails rows for the same user that land on one CB row. */
    collapsedDuplicates: number;
    inserted: number;
    updated: number;
    raceSkipped: number;
  };
  samples: {
    unmatchedRailsUserIds: number[];
    emailConflictRailsUserIds: number[];
    sharedEmailRailsUserIds: number[];
    unmappedLessons: Array<{ railsLessonId: number; slug: string | null; users: number }>;
    unmappedSeries: Array<{
      railsPlaylistId: number | null;
      railsSeriesId: number | null;
      slug: string | null;
    }>;
    writes: Array<{
      railsUserId: number;
      cbUserId: string;
      resourceId: string;
      kind: "lesson" | "course";
      action: "insert" | "update";
      completedAt: string;
    }>;
  };
};

type Candidate = {
  railsUserId: number;
  cbUserId: string;
  resourceId: string;
  kind: "lesson" | "course";
  railsRef:
    | { railsLessonId: number }
    | { railsPlaylistId: number | null; railsSeriesId: number | null };
  completedAt: Date;
};

type PlannedWrite =
  | (Candidate & { action: "insert" })
  | (Candidate & { action: "update"; priorUpdatedAt: Date | null });

type ExistingProgressRow = RowDataPacket & {
  userId: string;
  resourceId: string;
  completedAt: Date | null;
  updatedAt: Date | null;
  fields: unknown;
};

export function emptyProgressImportReceipt(input: {
  mode: "dry_run" | "apply";
  runId: string;
  source: string;
  afterRailsUserId: number;
  maxUsers?: number;
  catalog: CbContentCatalog;
  startedAt: Date;
}): ProgressImportReceipt {
  return {
    mode: input.mode,
    runId: input.runId,
    source: input.source,
    startedAt: input.startedAt.toISOString(),
    finishedAt: null,
    afterRailsUserId: input.afterRailsUserId,
    maxUsers: input.maxUsers ?? null,
    fullSource: false,
    lastRailsUserId: null,
    batches: 0,
    transactions: 0,
    catalog: input.catalog.stats,
    users: {
      seen: 0,
      matchedByLegacyRailsUserId: 0,
      matchedByEmail: 0,
      unmatchedNoCbUser: 0,
      unmatchedEmailConflict: 0,
      unmatchedSharedEmail: 0,
      matchedOtherCbUser: 0,
    },
    lessons: {
      seen: 0,
      mappedByRailsId: 0,
      mappedBySlug: 0,
      unmapped: 0,
      distinctUnmappedRailsLessonIds: 0,
      skippedForUnmatchedUser: 0,
    },
    series: {
      seen: 0,
      mappedByRailsPlaylistId: 0,
      mappedBySlug: 0,
      unmapped: 0,
      skippedForUnmatchedUser: 0,
    },
    rows: {
      toInsert: 0,
      toUpdate: 0,
      keptCbCompleted: 0,
      keptCbNewer: 0,
      keptFieldsNotObject: 0,
      collapsedDuplicates: 0,
      inserted: 0,
      updated: 0,
      raceSkipped: 0,
    },
    samples: {
      unmatchedRailsUserIds: [],
      emailConflictRailsUserIds: [],
      sharedEmailRailsUserIds: [],
      unmappedLessons: [],
      unmappedSeries: [],
      writes: [],
    },
  };
}

function pushSample<T>(samples: T[], value: T, limit = SAMPLE_LIMIT) {
  if (samples.length < limit) samples.push(value);
}

/** Tracks unmapped Rails lessons across batches so the receipt can name the biggest gaps. */
export class UnmappedLessonTally {
  readonly #byId = new Map<number, { slug: string | null; users: number }>();

  add(railsLessonId: number, slug: string | null) {
    const current = this.#byId.get(railsLessonId);
    if (current) current.users += 1;
    else this.#byId.set(railsLessonId, { slug, users: 1 });
  }

  applyTo(receipt: ProgressImportReceipt) {
    receipt.lessons.distinctUnmappedRailsLessonIds = this.#byId.size;
    receipt.samples.unmappedLessons = [...this.#byId.entries()]
      .map(([railsLessonId, value]) => ({
        railsLessonId,
        slug: value.slug,
        users: value.users,
      }))
      .toSorted(
        (left, right) => right.users - left.users || left.railsLessonId - right.railsLessonId,
      )
      .slice(0, UNMAPPED_LESSON_SAMPLE_LIMIT);
  }
}

function candidatesForUser(input: {
  user: RailsUserProgress;
  cbUserId: string;
  catalog: CbContentCatalog;
  receipt: ProgressImportReceipt;
  unmappedLessons: UnmappedLessonTally;
  fallbackCompletedAt: Date;
}) {
  const { user, cbUserId, catalog, receipt } = input;
  const candidates: Candidate[] = [];
  const completedAtFor = (completedAt: Date | null) =>
    completedAt ?? user.lastActiveAt ?? input.fallbackCompletedAt;

  for (const lesson of user.lessons) {
    receipt.lessons.seen += 1;
    let resourceId = catalog.lessonByRailsId.get(lesson.railsLessonId);
    if (resourceId) {
      receipt.lessons.mappedByRailsId += 1;
    } else {
      const slug = normalizeSlug(lesson.slug);
      resourceId = slug === null ? undefined : catalog.lessonBySlug.get(slug);
      if (resourceId) receipt.lessons.mappedBySlug += 1;
    }

    if (!resourceId) {
      receipt.lessons.unmapped += 1;
      input.unmappedLessons.add(lesson.railsLessonId, lesson.slug);
      continue;
    }

    candidates.push({
      railsUserId: user.railsUserId,
      cbUserId,
      resourceId,
      kind: "lesson",
      railsRef: { railsLessonId: lesson.railsLessonId },
      completedAt: completedAtFor(lesson.completedAt),
    });
  }

  for (const series of user.series) {
    receipt.series.seen += 1;
    let resourceId =
      series.railsPlaylistId === null
        ? undefined
        : catalog.courseByRailsPlaylistId.get(series.railsPlaylistId);
    if (resourceId) {
      receipt.series.mappedByRailsPlaylistId += 1;
    } else {
      const slug = normalizeSlug(series.slug);
      resourceId = slug === null ? undefined : catalog.courseBySlug.get(slug);
      if (resourceId) receipt.series.mappedBySlug += 1;
    }

    if (!resourceId) {
      receipt.series.unmapped += 1;
      pushSample(receipt.samples.unmappedSeries, {
        railsPlaylistId: series.railsPlaylistId,
        railsSeriesId: series.railsSeriesId,
        slug: series.slug,
      });
      continue;
    }

    candidates.push({
      railsUserId: user.railsUserId,
      cbUserId,
      resourceId,
      kind: "course",
      railsRef: { railsPlaylistId: series.railsPlaylistId, railsSeriesId: series.railsSeriesId },
      completedAt: completedAtFor(series.completedAt),
    });
  }

  return candidates;
}

/**
 * One candidate per (CB user, resource), keeping the latest Rails completion.
 * Collisions come from two Rails lessons (or playlists) mapping to one CB row.
 */
function collapseCandidates(candidates: readonly Candidate[], receipt: ProgressImportReceipt) {
  const byKey = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = `${candidate.cbUserId}\u001f${candidate.resourceId}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }
    receipt.rows.collapsedDuplicates += 1;
    if (candidate.completedAt > existing.completedAt) byKey.set(key, candidate);
  }
  return [...byKey.values()];
}

async function readExistingProgress(db: Pick<Connection, "execute">, cbUserIds: readonly string[]) {
  const existing = new Map<string, ExistingProgressRow>();
  if (cbUserIds.length === 0) return existing;

  const [rows] = await db.execute<ExistingProgressRow[]>(
    `
      SELECT userId, resourceId, completedAt, updatedAt, fields
      FROM egghead_ResourceProgress
      WHERE userId IN (${placeholders(cbUserIds.length)})
    `,
    [...cbUserIds],
  );
  for (const row of rows) existing.set(`${row.userId}\u001f${row.resourceId}`, row);

  return existing;
}

function isPlainObject(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function existingSource(fields: unknown) {
  if (!isPlainObject(fields) || typeof fields !== "object" || fields === null) return null;
  const source: unknown = Reflect.get(fields, "source");
  return typeof source === "string" ? source : null;
}

export function classifyProgressCandidate(
  candidate: { completedAt: Date },
  existing: { completedAt: Date | null; updatedAt: Date | null; fields: unknown } | undefined,
) {
  if (!existing) return "insert" as const;
  if (existing.completedAt !== null) return "kept_cb_completed" as const;
  if (
    existing.fields !== null &&
    existing.fields !== undefined &&
    !isPlainObject(existing.fields)
  ) {
    return "kept_fields_not_object" as const;
  }
  const explicitUncomplete = EXPLICIT_UNCOMPLETE_SOURCES.includes(
    existingSource(existing.fields) ?? "",
  );
  if (
    explicitUncomplete &&
    existing.updatedAt !== null &&
    existing.updatedAt.getTime() >= candidate.completedAt.getTime()
  ) {
    return "kept_cb_newer" as const;
  }
  return "update" as const;
}

function railsImportStamp(write: PlannedWrite, input: { runId: string; at: string }) {
  return JSON.stringify({
    runId: input.runId,
    at: input.at,
    action: write.action,
    railsUserId: write.railsUserId,
    rails: write.railsRef,
    completedAt: mysqlUtcDateTime(write.completedAt),
  });
}

function chunks<T>(items: readonly T[], size: number) {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size));
  }
  return result;
}

/** Runs `run` for each item, one at a time, on the caller's single connection. */
async function runInOrder<T>(items: readonly T[], run: (item: T) => Promise<void>) {
  await items.reduce<Promise<void>>(
    (previous, item) => previous.then(() => run(item)),
    Promise.resolve(),
  );
}

async function writeInserts(
  db: ProgressImportDb,
  inserts: readonly PlannedWrite[],
  stamp: { runId: string; at: string },
) {
  const totals = { inserted: 0, raceSkipped: 0 };
  await runInOrder(chunks(inserts, WRITE_CHUNK_SIZE), async (chunk) => {
    const values = chunk
      .map(
        () =>
          "(?, ?, CAST(? AS DATETIME(3)), CAST(? AS JSON), CURRENT_TIMESTAMP(3), CAST(? AS DATETIME(3)))",
      )
      .join(", ");
    // A row that appeared after planning keeps its CB state: the no-op
    // update leaves it untouched.
    const [result] = await db.execute<ResultSetHeader>(
      `
        INSERT INTO egghead_ResourceProgress
          (userId, resourceId, completedAt, fields, createdAt, updatedAt)
        VALUES ${values}
        ON DUPLICATE KEY UPDATE userId = userId
      `,
      chunk.flatMap((write) => [
        write.cbUserId,
        write.resourceId,
        mysqlUtcDateTime(write.completedAt),
        `{"source":${JSON.stringify(PROGRESS_IMPORT_SOURCE)},"railsImport":${railsImportStamp(write, stamp)}}`,
        stamp.at,
      ]),
    );
    totals.inserted += result.affectedRows;
    totals.raceSkipped += chunk.length - result.affectedRows;
  });
  return totals;
}

async function writeUpdates(
  db: ProgressImportDb,
  updates: readonly PlannedWrite[],
  stamp: { runId: string; at: string },
) {
  const totals = { updated: 0, raceSkipped: 0 };
  await runInOrder(chunks(updates, WRITE_CHUNK_SIZE), async (chunk) => {
    const incoming = chunk
      .map(
        () =>
          "SELECT ? AS userId, ? AS resourceId, CAST(? AS DATETIME(3)) AS completedAt, ? AS priorUpdatedAt, ? AS stamp",
      )
      .join(" UNION ALL ");
    // Optimistic guard: the row must still be exactly what planning read.
    // `prior.fields` is copied from the row itself, server-side.
    const [result] = await db.execute<ResultSetHeader>(
      `
        UPDATE egghead_ResourceProgress progress
        JOIN (${incoming}) incoming
          ON incoming.userId = progress.userId
         AND incoming.resourceId = progress.resourceId
        SET progress.fields = JSON_SET(
              COALESCE(progress.fields, JSON_OBJECT()),
              '$.railsImport',
              JSON_SET(
                CAST(incoming.stamp AS JSON),
                '$.prior',
                JSON_OBJECT('fields', progress.fields, 'updatedAt', incoming.priorUpdatedAt)
              )
            ),
            progress.completedAt = incoming.completedAt,
            progress.updatedAt = CAST(? AS DATETIME(3))
        WHERE progress.completedAt IS NULL
          AND progress.updatedAt <=> CAST(incoming.priorUpdatedAt AS DATETIME(3))
          AND JSON_TYPE(COALESCE(progress.fields, JSON_OBJECT())) = 'OBJECT'
      `,
      [
        ...chunk.flatMap((write) => [
          write.cbUserId,
          write.resourceId,
          mysqlUtcDateTime(write.completedAt),
          write.action === "update" && write.priorUpdatedAt
            ? mysqlUtcDateTime(write.priorUpdatedAt)
            : null,
          railsImportStamp(write, stamp),
        ]),
        stamp.at,
      ],
    );
    totals.updated += result.affectedRows;
    totals.raceSkipped += chunk.length - result.affectedRows;
  });
  return totals;
}

/**
 * Writes a batch in transactions of at most `MAX_ROWS_PER_TRANSACTION` rows.
 * A crash between transactions leaves earlier ones committed; the resume
 * cursor only moves after the whole batch, so a resume replays the batch and
 * the already-written rows classify as `kept_cb_completed`.
 */
async function writePlannedRows(
  db: ProgressImportDb,
  writes: readonly PlannedWrite[],
  receipt: ProgressImportReceipt,
) {
  await runInOrder(chunks(writes, MAX_ROWS_PER_TRANSACTION), async (group) => {
    const stamp = { runId: receipt.runId, at: mysqlUtcDateTime(new Date()) };
    await db.beginTransaction();
    try {
      const inserted = await writeInserts(
        db,
        group.filter((write) => write.action === "insert"),
        stamp,
      );
      const updated = await writeUpdates(
        db,
        group.filter((write) => write.action === "update"),
        stamp,
      );
      await db.commit();
      receipt.transactions += 1;
      receipt.rows.inserted += inserted.inserted;
      receipt.rows.updated += updated.updated;
      receipt.rows.raceSkipped += inserted.raceSkipped + updated.raceSkipped;
    } catch (error) {
      await db.rollback().catch(() => undefined);
      throw error;
    }
  });
}

/**
 * Plans one batch and, when `apply` is set, writes it. `restrictToCbUserId`
 * makes the per-user path refuse to write anyone else. `onBeforeWrite` gets
 * the CB user ids about to be written, before any transaction starts, so the
 * caller can record a rollback manifest.
 */
export async function importProgressBatch(input: {
  db: ProgressImportDb;
  users: readonly RailsUserProgress[];
  catalog: CbContentCatalog;
  receipt: ProgressImportReceipt;
  unmappedLessons: UnmappedLessonTally;
  apply: boolean;
  now: Date;
  emailOwners?: ReadonlyMap<string, number>;
  restrictToCbUserId?: string;
  onBeforeWrite?: (input: { cbUserIds: string[]; runId: string }) => Promise<void> | void;
}) {
  const { db, users, catalog, receipt } = input;
  const matches = await matchCbUsers(db, users, input.emailOwners);
  const candidates: Candidate[] = [];

  for (const user of users) {
    receipt.users.seen += 1;
    const match = matches.get(user.railsUserId);
    const matchedHere =
      match?.status === "matched" &&
      (input.restrictToCbUserId === undefined || match.cbUserId === input.restrictToCbUserId);

    if (!match || match.status === "unmatched" || !matchedHere) {
      if (match?.status === "matched") {
        receipt.users.matchedOtherCbUser += 1;
      } else if (match?.status === "unmatched" && match.reason === "email_conflict") {
        receipt.users.unmatchedEmailConflict += 1;
        pushSample(receipt.samples.emailConflictRailsUserIds, user.railsUserId);
      } else if (match?.status === "unmatched" && match.reason === "email_shared") {
        receipt.users.unmatchedSharedEmail += 1;
        pushSample(receipt.samples.sharedEmailRailsUserIds, user.railsUserId);
      } else {
        receipt.users.unmatchedNoCbUser += 1;
        pushSample(receipt.samples.unmatchedRailsUserIds, user.railsUserId);
      }
      receipt.lessons.skippedForUnmatchedUser += user.lessons.length;
      receipt.series.skippedForUnmatchedUser += user.series.length;
      continue;
    }

    if (match.matchedBy === "legacy_rails_user_id") receipt.users.matchedByLegacyRailsUserId += 1;
    else receipt.users.matchedByEmail += 1;

    candidates.push(
      ...candidatesForUser({
        user,
        cbUserId: match.cbUserId,
        catalog,
        receipt,
        unmappedLessons: input.unmappedLessons,
        fallbackCompletedAt: input.now,
      }),
    );
  }

  const collapsed = collapseCandidates(candidates, receipt);
  const existing = await readExistingProgress(db, [
    ...new Set(collapsed.map((candidate) => candidate.cbUserId)),
  ]);
  const writes: PlannedWrite[] = [];

  for (const candidate of collapsed) {
    const existingRow = existing.get(`${candidate.cbUserId}\u001f${candidate.resourceId}`);
    const decision = classifyProgressCandidate(candidate, existingRow);
    if (decision === "kept_cb_completed") {
      receipt.rows.keptCbCompleted += 1;
      continue;
    }
    if (decision === "kept_cb_newer") {
      receipt.rows.keptCbNewer += 1;
      continue;
    }
    if (decision === "kept_fields_not_object") {
      receipt.rows.keptFieldsNotObject += 1;
      continue;
    }

    if (decision === "insert") receipt.rows.toInsert += 1;
    else receipt.rows.toUpdate += 1;

    const write: PlannedWrite =
      decision === "update"
        ? { ...candidate, action: "update", priorUpdatedAt: existingRow?.updatedAt ?? null }
        : { ...candidate, action: "insert" };
    writes.push(write);
    pushSample(receipt.samples.writes, {
      railsUserId: write.railsUserId,
      cbUserId: write.cbUserId,
      resourceId: write.resourceId,
      kind: write.kind,
      action: write.action,
      completedAt: write.completedAt.toISOString(),
    });
  }

  receipt.batches += 1;
  const lastUser = users.at(-1);
  if (lastUser) receipt.lastRailsUserId = lastUser.railsUserId;

  if (!input.apply || writes.length === 0) return;

  await input.onBeforeWrite?.({
    cbUserIds: [...new Set(writes.map((write) => write.cbUserId))],
    runId: receipt.runId,
  });
  await writePlannedRows(db, writes, receipt);
}

/**
 * Bulk import. Walks the source in Rails user id order, in batches, starting
 * after `afterRailsUserId`. In apply mode `onBatchCommitted` runs after each
 * batch commits, so callers can persist the resume cursor. Pass the same
 * `runId` when resuming so one logical import has one runId.
 */
export async function runProgressImport(input: {
  db: ProgressImportDb;
  source: RailsProgressSource;
  apply: boolean;
  afterRailsUserId?: number;
  batchSize?: number;
  maxUsers?: number;
  catalog?: CbContentCatalog;
  now?: Date;
  runId?: string;
  onBeforeWrite?: (input: { cbUserIds: string[]; runId: string }) => Promise<void> | void;
  onBatchCommitted?: (cursor: {
    lastRailsUserId: number;
    receipt: ProgressImportReceipt;
  }) => Promise<void> | void;
}): Promise<ProgressImportReceipt> {
  await assertUtcSession(input.db);
  const now = input.now ?? new Date();
  const afterRailsUserId = input.afterRailsUserId ?? 0;
  const batchSize = Math.max(1, input.batchSize ?? DEFAULT_PROGRESS_IMPORT_BATCH_SIZE);
  const catalog = input.catalog ?? (await loadCbContentCatalog(input.db));
  const emailOwners = await input.source.emailOwners();
  const receipt = emptyProgressImportReceipt({
    mode: input.apply ? "apply" : "dry_run",
    runId: input.runId ?? newProgressImportRunId(now),
    source: input.source.description,
    afterRailsUserId,
    ...(input.maxUsers === undefined ? {} : { maxUsers: input.maxUsers }),
    catalog,
    startedAt: now,
  });
  const unmappedLessons = new UnmappedLessonTally();
  let batch: RailsUserProgress[] = [];
  let usersRead = 0;
  let stoppedEarly = false;

  const flush = async () => {
    if (batch.length === 0) return;
    await importProgressBatch({
      db: input.db,
      users: batch,
      catalog,
      receipt,
      unmappedLessons,
      apply: input.apply,
      now,
      emailOwners,
      ...(input.onBeforeWrite ? { onBeforeWrite: input.onBeforeWrite } : {}),
    });
    const lastRailsUserId = receipt.lastRailsUserId;
    batch = [];
    if (input.apply && lastRailsUserId !== null) {
      await input.onBatchCommitted?.({ lastRailsUserId, receipt });
    }
  };

  for await (const user of input.source.users({ afterRailsUserId })) {
    if (input.maxUsers !== undefined && usersRead >= input.maxUsers) {
      stoppedEarly = true;
      break;
    }
    usersRead += 1;
    batch.push(user);
    if (batch.length >= batchSize) await flush();
  }
  await flush();

  unmappedLessons.applyTo(receipt);
  receipt.fullSource = afterRailsUserId === 0 && !stoppedEarly && input.maxUsers === undefined;
  receipt.finishedAt = new Date().toISOString();
  return receipt;
}

// ---------------------------------------------------------------------------
// On demand: one CB user, for example at first sign-in.

export type UserProgressImportResult =
  | { status: "no_cb_user"; receipt: null }
  | { status: "no_rails_progress"; receipt: null }
  | { status: "not_matched"; receipt: ProgressImportReceipt }
  | { status: "imported"; receipt: ProgressImportReceipt };

/**
 * Imports one CB user's Rails progress from `source`, using the same matching
 * and write rules as the bulk import. It looks the learner up by the CB user's
 * stored Rails id, then by email, and writes only to that CB user. The session
 * must be UTC (`openUtcConnection`); the app's pool is refused.
 *
 * Wiring this into sign-in needs an indexed source; `jsonlRailsProgressSource`
 * scans a file and is a stub for that path.
 */
export async function importProgressForUser(
  userId: string,
  options: {
    db: ProgressImportDb;
    source: RailsProgressSource;
    apply: boolean;
    catalog?: CbContentCatalog;
    now?: Date;
    runId?: string;
  },
): Promise<UserProgressImportResult> {
  await assertUtcSession(options.db);
  const [userRows] = await options.db.execute<CbUserRow[]>(
    `
      SELECT id, email, legacyRailsUserId
      FROM egghead_User
      WHERE id = ?
      LIMIT 1
    `,
    [userId],
  );
  const user = userRows[0];
  if (!user) return { status: "no_cb_user", receipt: null };

  const railsUser = await options.source.findUser({
    railsUserId: positiveInteger(user.legacyRailsUserId),
    email: user.email,
  });
  if (!railsUser) return { status: "no_rails_progress", receipt: null };

  const now = options.now ?? new Date();
  const catalog = options.catalog ?? (await loadCbContentCatalog(options.db));
  const receipt = emptyProgressImportReceipt({
    mode: options.apply ? "apply" : "dry_run",
    runId: options.runId ?? newProgressImportRunId(now),
    source: options.source.description,
    afterRailsUserId: railsUser.railsUserId - 1,
    catalog,
    startedAt: now,
  });
  const unmappedLessons = new UnmappedLessonTally();

  await importProgressBatch({
    db: options.db,
    users: [railsUser],
    catalog,
    receipt,
    unmappedLessons,
    apply: options.apply,
    now,
    emailOwners: await options.source.emailOwners(),
    restrictToCbUserId: user.id,
  });

  unmappedLessons.applyTo(receipt);
  receipt.finishedAt = new Date().toISOString();

  const matched = receipt.users.matchedByLegacyRailsUserId + receipt.users.matchedByEmail > 0;
  return { status: matched ? "imported" : "not_matched", receipt };
}
